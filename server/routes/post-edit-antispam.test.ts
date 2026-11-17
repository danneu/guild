import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Intent: one member cannot make the spam classifier run faster than the
// screening budget allows, however fast they edit, and no edit lands without
// being screened.
// Why it exists: PUT /posts/:id had no throttle and classified every edit by
// an untrusted member. One account looping edits could fill the API's rate
// limits or spend cap, and a failed call lets every post through (hunt
// 261117-0852-022).
// Scenario: a new member with one post sends 50 edits in quick succession,
// alternating two texts so none is skipped as unchanged.

// The per-minute pace this test holds the route to.
const CALLS_PER_MINUTE = 3;

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  SCREEN_CALLS_PER_MINUTE: 3,
}));

const fake = vi.hoisted(() => ({
  query: null as unknown as (sql: string, params?: unknown[]) => unknown,
}));

// The real post loader and post writes run against the fake database below.
vi.mock("../db/util", () => {
  const query = (sql: string, params?: unknown[]) => fake.query(sql, params);
  const client = { _inTransaction: true, query };
  return {
    pool: {
      query,
      withTransaction: (fn: (c: unknown) => unknown) => fn(client),
    },
    maybeOneRow: (res: { rows: unknown[] }) => res.rows[0],
    exactlyOneRow: (res: { rows: unknown[] }) => {
      if (res.rows.length !== 1) throw new Error("expected exactly one row");
      return res.rows[0];
    },
    withPgPoolTransaction: (_pool: unknown, fn: (c: unknown) => unknown) =>
      fn(client),
  };
});

vi.mock("../services/antispam/claude", () => ({
  default: { analyze: vi.fn() },
}));
vi.mock("../services/discord", () => ({
  broadcastAutoNuke: vi.fn(() => Promise.resolve()),
  broadcastFirstPost: vi.fn(() => Promise.resolve()),
  broadcastSpamReview: vi.fn(() => Promise.resolve()),
}));

// server/bbcode.js loads cache3 with a CommonJS require that vitest cannot
// resolve to a .ts file, and no test here reads the rendered HTML.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

import * as cancan from "../cancan";
import claude from "../services/antispam/claude";
import "../validation";
import topicsRouter from "./topics";

const analyze = vi.mocked(claude.analyze);

////////////////////////////////////////////////////////////
// Fake database

const member = {
  id: 7,
  uname: "Newbie",
  slug: "newbie",
  role: "member",
  approved_at: null,
  posts_count: 1,
};
const topic = {
  id: 20,
  forum_id: 3,
  user_id: member.id,
  co_gm_ids: [] as number[],
  is_hidden: false,
  is_roleplay: false,
  banned_ids: [] as number[],
};
const forum = { id: 3, category_id: 2 };
const POST_ID = 300;

// The database clock, frozen: every edit lands in the same instant.
const NOW = new Date("2026-11-17T12:00:00Z");

type Ledger = { id: string; cost: number; created_at: Date }[];

// Answers the post loader, the post update and the screening ledger the way
// Postgres would, and records what the edits stored. Any other query throws,
// so a route that reaches one fails at once.
function makeDatabase() {
  const db = {
    markup: "Hello, I am new here.",
    stored: [] as string[],
    ledger: [] as Ledger,
  };
  let nextSpendId = 1;
  fake.query = async (sql: string, params: unknown[] = []) => {
    const rows = ((): unknown[] => {
      if (/FROM posts p[\s\S]*WHERE p\.id = \$1/.test(sql)) {
        return [
          {
            id: POST_ID,
            user_id: member.id,
            topic_id: topic.id,
            idx: 0,
            type: "ooc",
            is_hidden: false,
            markup: db.markup,
            topic: { ...topic },
            forum: { ...forum },
          },
        ];
      }
      if (/UPDATE posts/.test(sql)) {
        db.markup = params[2] as string;
        db.stored.push(db.markup);
        return [{ id: POST_ID, user_id: member.id, markup: db.markup }];
      }
      if (/pg_advisory_xact_lock/.test(sql)) return [];
      if (/FROM users/.test(sql)) {
        const { id, uname, approved_at, posts_count } = member;
        return [{ id, uname, approved_at, posts_count }];
      }
      if (/clock_timestamp\(\)/.test(sql)) return [{ now: NOW }];
      if (/DELETE FROM screen_spends/.test(sql)) {
        const ids = params[0] as string[];
        db.ledger = db.ledger.filter((s) => !ids.includes(s.id));
        return [];
      }
      if (/INSERT INTO screen_spends/.test(sql)) {
        db.ledger.push({
          id: String(nextSpendId++),
          cost: params[1] as number,
          created_at: params[2] as Date,
        });
        return [];
      }
      if (/FROM screen_spends/.test(sql))
        return db.ledger.map((s) => ({ ...s }));
      throw new Error(`fake database has no answer for: ${sql}`);
    })();
    return { rows, rowCount: rows.length };
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  analyze.mockResolvedValue({
    ok: true,
    verdict: {
      isSpam: false,
      confidence: 0.99,
      category: "legitimate",
      reasoning: "test",
      injectionAttempt: false,
    },
  });
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what the route reads from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts.

async function withServer(
  currUser: object,
  fn: (put: (body: object) => Promise<number>) => Promise<void>,
) {
  let body: object = {};
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = currUser;
    (ctx.request as any).body = body;
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    return next();
  });
  app.use(bouncer.middleware());
  app.use(topicsRouter.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(async (next) => {
      body = next;
      const res = await fetch(`http://127.0.0.1:${port}/posts/${POST_ID}`, {
        method: "PUT",
        redirect: "manual",
      });
      return res.status;
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

describe("PUT /posts/:id", () => {
  it("screens a new member's burst of edits only as fast as the budget pays", async () => {
    const db = makeDatabase();

    await withServer(member, async (put) => {
      for (let i = 0; i < 50; i++) {
        await put({ markup: i % 2 === 0 ? "Edit A" : "Edit B" });
      }
    });

    expect(analyze.mock.calls.length).toBeLessThanOrEqual(CALLS_PER_MINUTE);
    // Every edit that landed was screened: the refused ones wrote nothing.
    expect(db.stored).toHaveLength(analyze.mock.calls.length);
  });
});
