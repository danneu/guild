import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The per-minute pace this file holds the routes to.
const CALLS_PER_MINUTE = 3;

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  SCREEN_CALLS_PER_MINUTE: 3,
}));

const fake = vi.hoisted(() => ({
  query: null as unknown as (sql: string, params?: unknown[]) => unknown,
}));

// The real post loader, post writes and nukeUser run against the fake
// database below.
vi.mock("../db/util", () => {
  // nukeUser passes { text, values } config objects.
  const query = (
    sql: string | { text: string; values: unknown[] },
    params?: unknown[],
  ) =>
    typeof sql === "string"
      ? fake.query(sql, params)
      : fake.query(sql.text, sql.values);
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
import claude, { type AnalyzeResult } from "../services/antispam/claude";
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
// An approved member, so the classifier skips their edits
const gm = {
  id: 8,
  uname: "Gm",
  slug: "gm",
  role: "member",
  approved_at: new Date("2026-01-01T00:00:00Z"),
  posts_count: 50,
};
// A new member the GM made co-GM. UPDATE_POST lets a co-GM edit the GM's 0th
// posts.
const coGm = {
  id: 9,
  uname: "CoGm",
  slug: "cogm",
  role: "member",
  approved_at: null,
  posts_count: 1,
};
const users = [member, gm, coGm];

const topic = {
  id: 20,
  forum_id: 3,
  user_id: gm.id,
  co_gm_ids: [coGm.id],
  is_hidden: false,
  is_roleplay: true,
  banned_ids: [] as number[],
};
const forum = { id: 3, category_id: 2 };

// The member's reply, and the GM's 0th posts in two tabs
const POST_ID = 300;
const IC_ZEROTH_ID = 301;
const OOC_ZEROTH_ID = 302;

// The database clock, frozen: every edit lands in the same instant.
const NOW = new Date("2026-11-17T12:00:00Z");

type Post = {
  id: number;
  user_id: number;
  idx: number;
  type: string;
  markup: string;
  is_hidden: boolean;
};
type Ledger = { id: string; cost: number; created_at: Date }[];

// Answers the post loader, the post edit, the screening ledger and nukeUser
// the way Postgres would, and records what the edits stored. Any other query
// throws, so a route that reaches one fails at once.
function makeDatabase() {
  const db = {
    posts: new Map<number, Post>(
      [
        [POST_ID, member.id, 0, "ooc", "Hello, I am new here."],
        [IC_ZEROTH_ID, gm.id, -1, "ic", "The GM's opening scene."],
        [OOC_ZEROTH_ID, gm.id, -1, "ooc", "The GM's rules for players."],
      ].map(([id, user_id, idx, type, markup]) => [
        id as number,
        {
          id: id as number,
          user_id: user_id as number,
          idx: idx as number,
          type: type as string,
          markup: markup as string,
          is_hidden: false,
        },
      ]),
    ),
    stored: [] as string[],
    ledger: [] as Ledger,
    nuked: new Set<number>(),
  };
  let nextSpendId = 1;
  fake.query = async (sql: string, params: unknown[] = []) => {
    const rows = ((): unknown[] => {
      if (/FROM posts p[\s\S]*WHERE p\.id = \$1/.test(sql)) {
        const post = db.posts.get(Number(params[0]));
        if (!post) return [];
        return [
          {
            ...post,
            topic_id: topic.id,
            topic: { ...topic },
            forum: { ...forum },
          },
        ];
      }
      // An edit saves a revision and the post in one statement.
      if (/INSERT INTO post_revs[\s\S]*UPDATE posts/.test(sql)) {
        const post = db.posts.get(params[1] as number)!;
        post.markup = params[2] as string;
        db.stored.push(post.markup);
        return [{ ...post, html: params[3] }];
      }
      // A NUKE verdict hides a post the actor edited but does not own, while
      // it still holds the text that was classified.
      if (
        /UPDATE posts\s+SET is_hidden = true\s+WHERE id = \$1\s+AND markup = \$2/.test(
          sql,
        )
      ) {
        const post = db.posts.get(params[0] as number);
        if (!post || post.markup !== params[1]) return [];
        post.is_hidden = true;
        return [{ id: post.id }];
      }
      // nukeUser
      if (/UPDATE users SET role = 'banned'/.test(sql)) return [];
      if (/UPDATE topics SET is_hidden = true WHERE user_id = \$1/.test(sql)) {
        return [];
      }
      if (/UPDATE posts SET is_hidden = true WHERE user_id = \$1/.test(sql)) {
        for (const post of db.posts.values()) {
          if (post.user_id === params[0]) post.is_hidden = true;
        }
        return [];
      }
      if (/INSERT INTO nuked_users/.test(sql)) {
        const userId = params[0] as number;
        if (db.nuked.has(userId)) {
          throw Object.assign(
            new Error(
              'duplicate key value violates unique constraint "nuked_user_id"',
            ),
            { code: "23505", constraint: "nuked_user_id" },
          );
        }
        db.nuked.add(userId);
        return [];
      }
      // The actor's standing, read under their lock
      if (/pg_advisory_xact_lock/.test(sql)) return [];
      if (/FROM users/.test(sql)) {
        const user = users.find((u) => u.id === params[0])!;
        const { id, uname, approved_at, posts_count } = user;
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

function verdict(isSpam: boolean, confidence: number): AnalyzeResult {
  return {
    ok: true,
    verdict: {
      isSpam,
      confidence,
      category: isSpam ? "gambling_betting" : "legitimate",
      reasoning: "test",
      injectionAttempt: false,
    },
  };
}

// The text each classifier call was sent as its body, in call order
function screenedBodies(): string[] {
  return analyze.mock.calls.map(([charge]) => charge.body);
}

// Holds each classifier call until the test hands it a verdict, so a test
// decides when and in what order the verdicts come back.
function holdVerdicts() {
  const held: ((result: AnalyzeResult) => void)[] = [];
  analyze.mockImplementation(
    () => new Promise<AnalyzeResult>((resolve) => held.push(resolve)),
  );
  return held;
}

// Lets the screening a route started after its response run to the end.
// Every fake here answers at once, so it finishes before the next turn of the
// event loop.
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  analyze.mockResolvedValue(verdict(false, 0.99));
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what the routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts.

type Send = (
  currUser: object,
  path: string,
  body: { markup: string },
) => Promise<number>;

async function withServer(fn: (send: Send) => Promise<void>) {
  let currUser: object = {};
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
    await fn(async (user, path, next) => {
      currUser = user;
      body = next;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
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
  // Intent: one member cannot make the spam classifier run faster than the
  // screening budget allows, however fast they edit, and no edit lands
  // without being screened.
  // Why it exists: PUT /posts/:id had no throttle and classified every edit
  // by an untrusted member. One account looping edits could fill the API's
  // rate limits or spend cap, and a failed call lets every post through
  // (hunt 261117-0852-022).
  // Scenario: a new member with one post sends 50 edits in quick succession,
  // alternating two texts so none is skipped as unchanged.
  it("screens a new member's burst of edits only as fast as the budget pays", async () => {
    const db = makeDatabase();

    await withServer(async (send) => {
      for (let i = 0; i < 50; i++) {
        await send(member, `/posts/${POST_ID}`, {
          markup: i % 2 === 0 ? "Edit A" : "Edit B",
        });
      }
    });
    await settle();

    expect(analyze.mock.calls.length).toBeLessThanOrEqual(CALLS_PER_MINUTE);
    // Every edit that landed was screened: the refused ones wrote nothing.
    expect(db.stored).toHaveLength(analyze.mock.calls.length);
  });
});

describe("PUT /api/posts/:id", () => {
  // Intent: the classifier sees an untrusted member's edit saved through the
  // Edit button on the topic page.
  // Why it exists: this route saved the edit and dropped its screening
  // charge, so a new member could post clean text and then edit it into spam
  // the classifier never saw (hunt 261117-0852-027).
  // Scenario: a new member edits their only post with the Edit button.
  it("screens a new member's edit", async () => {
    makeDatabase();

    await withServer(async (send) => {
      const status = await send(member, `/api/posts/${POST_ID}`, {
        markup: "Buy cheap coins at spam.example",
      });
      expect(status).toBe(200);
    });
    await settle();

    expect(screenedBodies()).toEqual(["Buy cheap coins at spam.example"]);
  });

  // Intent: a NUKE verdict on a co-GM's edit hides the GM's post only while
  // the post still holds the text that was classified.
  // Why it exists: nukeUser hides only the nuked account's own rows, so a
  // co-GM's spam edit of the GM's 0th post stayed up. A verdict comes back
  // after the response, so by then the GM may have fixed the post, and
  // hiding it then would hide the GM's own text.
  // Scenario: a new co-GM edits both of the GM's 0th posts into spam. Before
  // any verdict comes back, the GM fixes the OOC one. Its verdict comes back
  // first and nukes the co-GM; the IC one's comes back after.
  it("hides a co-GM's spam edit of the GM's post only while it still holds it", async () => {
    const db = makeDatabase();
    const held = holdVerdicts();

    await withServer(async (send) => {
      const edits = [
        [coGm, IC_ZEROTH_ID, "Buy coins at spam.example"],
        [coGm, OOC_ZEROTH_ID, "Cheap coins at spam.example"],
        [gm, OOC_ZEROTH_ID, "Rules: be kind to each other."],
      ] as const;
      for (const [user, postId, markup] of edits) {
        expect(await send(user, `/api/posts/${postId}`, { markup })).toBe(200);
      }
    });
    await settle();
    expect(screenedBodies()).toEqual([
      "Buy coins at spam.example",
      "Cheap coins at spam.example",
    ]);

    held[1]!(verdict(true, 0.95));
    await settle();
    held[0]!(verdict(true, 0.95));
    await settle();

    expect(db.nuked).toEqual(new Set([coGm.id]));
    expect(db.posts.get(OOC_ZEROTH_ID)).toMatchObject({
      markup: "Rules: be kind to each other.",
      is_hidden: false,
    });
    expect(db.posts.get(IC_ZEROTH_ID)).toMatchObject({
      markup: "Buy coins at spam.example",
      is_hidden: true,
    });
  });
});
