// Intent: each kind of row a member can create over and over outside posts and
// sends has an hourly budget per account. Its writer refuses a row past the
// budget before it inserts, and counts only the member's own rows from the
// trailing hour. Runs on real rows in a real Postgres (server/testing/db.ts).
// Why it exists: dice campaigns, dice rolls and albums had no bound at all,
// so one account could create them as fast as it sent requests (hunt
// 261117-0852-055).

import assert from "assert";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Small, so a test reaches a budget with a few rows
const BUDGET = vi.hoisted(() => ({ untrusted: 2, trusted: 4 }));

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  ROW_BUDGET_PER_HOUR: {
    campaign: BUDGET,
    roll: BUDGET,
    album: BUDGET,
  },
}));

vi.mock("./util", async (importOriginal) =>
  (await import("../testing/db")).onTestDatabase(
    await importOriginal<typeof import("./util")>(),
  ),
);

import { roll } from "../dice";
import { MemberRefusal } from "../member_refusal";
import { closeTestDatabase, emptyTables } from "../testing/db";
import { sanitizeUserHtml } from "../user_html";
import { insertCampaign, insertRoll } from "./dice";
import { insertAlbum } from "./images";
import { pool } from "./util";

beforeEach(emptyTables);
afterAll(closeTestDatabase);

const MINUTE = 60;

// A member with no posts, so new (server/trust.ts)
async function createMember(uname: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO users (uname, digest, email, slug)
    VALUES ($1, '', $1 || '@example.com', $1)
    RETURNING id
  `,
    [uname],
  );
  return rows[0]!.id;
}

// A campaign the member owns, made before the test window
async function seedCampaign(userId: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO campaigns (user_id, title, created_at)
    VALUES ($1, 'Old campaign', now() - interval '1 day')
    RETURNING id
  `,
    [userId],
  );
  return rows[0]!.id;
}

const rolled = roll("1d6");
assert(rolled.type === "OK");

// Each budgeted kind: its table, how a test seeds `count` of the member's rows
// made `ageSeconds` ago, and the writer under test
const KINDS = [
  {
    kind: "campaign",
    table: "campaigns",
    seed: (userId: number, count: number, ageSeconds: number) =>
      pool.query(
        `
        INSERT INTO campaigns (user_id, title, created_at)
        SELECT $1, 'Seeded', now() - make_interval(secs => $3)
        FROM generate_series(1, $2)
      `,
        [userId, count, ageSeconds],
      ),
    write: (userId: number) =>
      insertCampaign(userId, "Campaign", "Hi", sanitizeUserHtml("Hi")),
  },
  {
    kind: "roll",
    table: "rolls",
    seed: async (userId: number, count: number, ageSeconds: number) =>
      pool.query(
        `
        INSERT INTO rolls (user_id, campaign_id, syntax, rolls, total, created_at)
        SELECT $1, $2, '1d6', '[]', 1, now() - make_interval(secs => $4)
        FROM generate_series(1, $3)
      `,
        [userId, await seedCampaign(userId), count, ageSeconds],
      ),
    write: async (userId: number) => {
      const { rows } = await pool.query<{ id: number }>(
        `SELECT id FROM campaigns WHERE user_id = $1`,
        [userId],
      );
      const campaignId = rows[0]?.id ?? (await seedCampaign(userId));
      return insertRoll(userId, campaignId, rolled, "note");
    },
  },
  {
    kind: "album",
    table: "albums",
    seed: (userId: number, count: number, ageSeconds: number) =>
      pool.query(
        `
        INSERT INTO albums (user_id, title, created_at)
        SELECT $1, 'Seeded', now() - make_interval(secs => $3)
        FROM generate_series(1, $2)
      `,
        [userId, count, ageSeconds],
      ),
    write: (userId: number) =>
      insertAlbum({ userId, title: "Album", markup: null }),
  },
];

async function rowCount(table: string, userId: number): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`,
    [userId],
  );
  return rows[0]!.n;
}

describe("row budgets", () => {
  it.each(KINDS)(
    "refuses a new member's $kind past the hourly budget before it inserts",
    async ({ table, seed, write }) => {
      const alice = await createMember("alice");
      await seed(alice, BUDGET.untrusted, 59 * MINUTE);

      await expect(write(alice)).rejects.toBeInstanceOf(MemberRefusal);

      expect(await rowCount(table, alice)).toBe(BUDGET.untrusted);
    },
  );

  // Scenario: Alice's own rows are over an hour old, and Bob's, made inside
  // the hour, fill his budget.
  it.each(KINDS)(
    "counts only the member's own $kind rows from the past hour",
    async ({ table, seed, write }) => {
      const alice = await createMember("alice");
      const bob = await createMember("bob");
      await seed(alice, BUDGET.untrusted, 61 * MINUTE);
      await seed(bob, BUDGET.untrusted, 59 * MINUTE);

      await write(alice);

      expect(await rowCount(table, alice)).toBe(BUDGET.untrusted + 1);
    },
  );
});
