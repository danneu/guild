import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readSqlFile } from "../schema_files";
import { closeTestDatabase, emptyTables } from "../testing/db";
import { claimRelay, decideRelay } from "./member_relays";
import { pool } from "./util";

vi.mock("./util", async (importOriginal) =>
  (await import("../testing/db")).onTestDatabase(
    await importOriginal<typeof import("./util")>(),
  ),
);

// A small ceiling, so a test fills it with a few claims
const CEILING = vi.hoisted(() => 3);
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  MEMBER_RELAY_CEILING_PER_HOUR: CEILING,
}));

beforeEach(emptyTables);
afterAll(closeTestDatabase);

const NOW = new Date("2026-11-17T12:00:00Z");
const MINUTE = 60;

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60 * 1000);
}

describe("decideRelay", () => {
  it("posts nothing for a member's second claim of a kind", () => {
    expect(decideRelay({ isNew: false }, 3)).toBe("repeat");
  });

  it("posts a new claim while the kind is at or under its ceiling", () => {
    expect(
      decideRelay({ isNew: true, count: 3, lastNoteAt: null, now: NOW }, 3),
    ).toBe("post");
  });

  // Intent: a claim past the ceiling is held, and staff hear that the kind is
  // held at most once an hour, however long the flood lasts.
  // Why it exists: the count is over a rolling hour, so it can cross the
  // ceiling many times in a flood, and a note on each crossing would flood
  // #forum-activity instead (hunt 261117-0852-012).
  // Scenario: claims past the ceiling with no note yet, a note 59 minutes
  // ago, and a note an hour ago.
  it("holds a claim past the ceiling and notes it at most once an hour", () => {
    const over = { isNew: true, count: 4, now: NOW } as const;

    expect(decideRelay({ ...over, lastNoteAt: null }, 3)).toBe("hold-and-note");
    expect(decideRelay({ ...over, lastNoteAt: minutesAgo(59) }, 3)).toBe(
      "hold",
    );
    expect(decideRelay({ ...over, lastNoteAt: minutesAgo(60) }, 3)).toBe(
      "hold-and-note",
    );
  });
});

////////////////////////////////////////////////////////////
// Real rows (server/testing/db.ts). Seeds are stamped relative to the
// database's now(), the clock claimRelay reads.

async function createUsers(count: number): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO users (uname, digest, email, slug)
    SELECT 'member' || n, '', 'member' || n || '@example.com', 'member' || n
    FROM generate_series(1, $1::int) AS n
    RETURNING id
  `,
    [count],
  );
  return rows.map((row) => row.id);
}

// Rows written as if claimRelay had made them ageSeconds ago
async function seedRows(kind: string, userIds: number[], ageSeconds: number) {
  await pool.query(
    `
    INSERT INTO member_relays (user_id, kind, created_at)
    SELECT unnest($1::int[]), $2, now() - make_interval(secs => $3)
  `,
    [userIds, kind, ageSeconds],
  );
}

async function relayRows(): Promise<{ user_id: number; kind: string }[]> {
  const { rows } = await pool.query(
    `SELECT user_id, kind FROM member_relays ORDER BY kind, user_id`,
  );
  return rows;
}

describe("claimRelay", () => {
  // Intent: each member relays each kind once, and kinds and members are
  // claimed apart.
  // Why it exists: every Introduce Yourself topic relayed another welcome to
  // the public #general, so one account could flood it (hunt 261117-0852-012).
  // Scenario: alice claims intro twice, then first_post; bob claims intro.
  it("relays each member's kind once", async () => {
    const [alice, bob] = await createUsers(2);

    expect(await claimRelay("intro", alice!)).toBe("post");
    expect(await claimRelay("intro", alice!)).toBe("repeat");
    expect(await claimRelay("first_post", alice!)).toBe("post");
    expect(await claimRelay("intro", bob!)).toBe("post");

    expect(await relayRows()).toEqual([
      { user_id: alice, kind: "first_post" },
      { user_id: alice, kind: "intro" },
      { user_id: bob, kind: "intro" },
    ]);
  });

  // Intent: past its hourly ceiling a kind's new claims are held but kept, so
  // a held member never relays later by trying again, and staff get one note.
  // Why it exists: a crowd of new accounts each relaying once would still
  // flood the channel (hunt 261117-0852-012).
  // Scenario: the ceiling's worth of intro claims 59 minutes old, then two
  // new members, then the first of them again.
  it("holds new claims past the ceiling and keeps them", async () => {
    const users = await createUsers(CEILING + 2);
    const [held, next] = users.slice(CEILING);
    await seedRows("intro", users.slice(0, CEILING), 59 * MINUTE);

    expect(await claimRelay("intro", held!)).toBe("hold-and-note");
    expect(await claimRelay("intro", next!)).toBe("hold");
    expect(await claimRelay("intro", held!)).toBe("repeat");

    const { rows } = await pool.query(
      `SELECT user_id FROM member_relays WHERE kind = 'intro:paused'`,
    );
    expect(rows).toEqual([{ user_id: held }]);
  });

  it("forgets claims made over an hour ago", async () => {
    const users = await createUsers(CEILING + 1);
    await seedRows("intro", users.slice(0, CEILING), 61 * MINUTE);

    expect(await claimRelay("intro", users[CEILING]!)).toBe("post");
  });

  // Scenario: first_post and intro are full, and staff were told about
  // first_post a minute ago; bio has no claims.
  it("counts and notes each kind apart", async () => {
    const users = await createUsers(CEILING + 1);
    const newcomer = users[CEILING]!;
    await seedRows("first_post", users.slice(0, CEILING), MINUTE);
    await seedRows("first_post:paused", [users[0]!], MINUTE);
    await seedRows("intro", users.slice(0, CEILING), MINUTE);

    expect(await claimRelay("bio", newcomer)).toBe("post");
    expect(await claimRelay("intro", newcomer)).toBe("hold-and-note");
  });

  // Intent: during a long flood staff hear again once the cooldown passes,
  // and the newest note decides.
  // Scenario: a full hour of intro claims and a note 61 minutes old, then two
  // new members.
  it("notes a held kind again once the cooldown has passed", async () => {
    const users = await createUsers(CEILING + 2);
    const [first, second] = users.slice(CEILING);
    await seedRows("intro", users.slice(0, CEILING), MINUTE);
    await seedRows("intro:paused", [users[0]!], 61 * MINUTE);

    expect(await claimRelay("intro", first!)).toBe("hold-and-note");
    expect(await claimRelay("intro", second!)).toBe("hold");
  });
});

describe("sql/18-member-relays.sql", () => {
  // Intent: the migration fills in one intro claim per member who already
  // has an Introduce Yourself topic, dated at their first one, and can run
  // again.
  // Why it exists: without it, each member's next intro after the deploy is
  // welcomed in #general again (hunt 261117-0852-012).
  // Scenario: alice has two intro topics, bob has a topic only in another
  // forum. The file runs twice.
  it("fills in an intro claim per member with an intro topic", async () => {
    const [alice, bob] = await createUsers(2);
    await pool.query(`
      INSERT INTO categories (id, title, pos) VALUES (1, 'Community', 0);
      INSERT INTO forums (id, category_id, title, pos)
      VALUES (2, 1, 'Introduce Yourself', 0), (3, 1, 'Off-topic', 1);
    `);
    await pool.query(
      `
      INSERT INTO topics (title, user_id, forum_id, is_roleplay, created_at)
      VALUES ('Hello', $1, 2, false, now() - interval '2 years'),
             ('Hello again', $1, 2, false, now() - interval '1 year'),
             ('Elsewhere', $2, 3, false, now() - interval '1 year')
    `,
      [alice, bob],
    );

    const migration = readSqlFile("18-member-relays.sql");
    await pool.query(migration);
    await pool.query(migration);

    const { rows } = await pool.query(`
      SELECT user_id, kind, created_at < now() - interval '23 months' AS dated_first
      FROM member_relays
    `);
    expect(rows).toEqual([
      { user_id: alice, kind: "intro", dated_first: true },
    ]);
    expect(await claimRelay("intro", alice!)).toBe("repeat");
    expect(await claimRelay("intro", bob!)).toBe("post");
  });
});
