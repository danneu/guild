import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cancan from "../cancan";
import * as db from "../db";
import { pool } from "../db/util";
import "../validation";
import indexRouter from "./index";
import topicsRouter from "./topics";

// The real loaders in server/db run against the fake database below, so these
// tests see exactly the columns each loader's SQL selects. Only the writes and
// their side effects are stubbed, so a test can watch whether they ran.
vi.mock("../db/util", () => ({
  pool: { query: vi.fn() },
  maybeOneRow: (res: { rows: unknown[] }) => res.rows[0],
  withPgPoolTransaction: async (_pool: unknown, fn: (client: {}) => unknown) =>
    fn({}),
}));

vi.mock("../db", async (importOriginal) => {
  const real = await importOriginal<typeof import("../db")>();
  return {
    ...real,
    createPost: vi.fn(),
    parseAndCreateMentionNotifications: vi.fn(),
    parseAndCreateQuoteNotifications: vi.fn(),
    createSubNotificationsBulk: vi.fn(),
    ratelimits: { ...real.ratelimits, bump: vi.fn() },
    subscriptions: {
      ...real.subscriptions,
      listActiveSubscribersForTopic: vi.fn(),
    },
    revs: { ...real.revs, getPostRev: vi.fn(), revertPostRev: vi.fn() },
  };
});

vi.mock("../services", () => ({
  default: { antispam: { process: vi.fn() } },
}));

// server/bbcode.js loads cache3 with a CommonJS require that vitest cannot
// resolve to a .ts file, and no test here reads the rendered HTML.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

////////////////////////////////////////////////////////////
// Fake database

const gm = { id: 1, uname: "Gm", slug: "gm", role: "member", posts_count: 50 };
const banned = {
  id: 2,
  uname: "Banned",
  slug: "banned",
  role: "member",
  posts_count: 50,
};
const player = {
  id: 3,
  uname: "Player",
  slug: "player",
  role: "member",
  posts_count: 50,
};

const forum = { id: 5, title: "Roleplays", category_id: 2, is_roleplay: true };
const topic = {
  id: 10,
  title: "Quest",
  forum_id: forum.id,
  user_id: gm.id,
  co_gm_ids: [] as number[],
  is_hidden: false,
  is_closed: false,
};
const bannedPost = {
  id: 100,
  topic_id: topic.id,
  user_id: banned.id,
  idx: 1,
  type: "ic",
  is_hidden: false,
};
const playerPost = {
  id: 101,
  topic_id: topic.id,
  user_id: player.id,
  idx: 2,
  type: "ic",
  is_hidden: false,
};
const posts = [bannedPost, playerPost];
const topicBans = [
  { topic_id: topic.id, banned_by_id: gm.id, banned_id: banned.id },
];

// Answers the by-id topic and post loaders the way Postgres would. A row
// carries banned_ids only when the query selects it from topic_bans. Any
// other query throws, so a route that reaches one fails at once.
async function fakeQuery(sql: string, params: unknown[] = []) {
  const id = Number(params[0]);
  function withBans(row: object, topicId: number) {
    if (!/FROM topic_bans/.test(sql)) return row;
    const ids = topicBans
      .filter((b) => b.topic_id === topicId)
      .map((b) => b.banned_id);
    return { ...row, banned_ids: ids };
  }
  if (/FROM posts p[\s\S]*WHERE p\.id = \$1/.test(sql)) {
    const post = posts.find((p) => p.id === id);
    if (!post) return { rows: [] };
    const row = { ...post, topic: { ...topic }, forum: { ...forum } };
    return { rows: [withBans(row, post.topic_id)] };
  }
  if (/FROM topics t[\s\S]*WHERE t\.id = \$1/.test(sql)) {
    if (id !== topic.id) return { rows: [] };
    return { rows: [withBans({ ...topic, forum: { ...forum } }, topic.id)] };
  }
  throw new Error(`fake database has no answer for: ${sql}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pool.query).mockImplementation(fakeQuery as any);
  vi.mocked(db.createPost).mockImplementation(
    async (_client: any, props: any) =>
      ({
        id: 200,
        topic_id: props.topicId,
        user_id: props.userId,
        markup: props.markup,
      }) as any,
  );
  vi.mocked(db.parseAndCreateMentionNotifications).mockResolvedValue([]);
  vi.mocked(db.parseAndCreateQuoteNotifications).mockResolvedValue([]);
  vi.mocked(db.subscriptions.listActiveSubscribersForTopic).mockResolvedValue(
    [],
  );
  vi.mocked(db.revs.getPostRev).mockImplementation(
    async (postId: number, revId: number) =>
      ({ id: revId, post_id: postId }) as any,
  );
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts, so a denied check is a 404 too.

type Req = {
  method: "POST";
  path: string;
  currUser: object;
  body?: object;
};

async function send(req: Req) {
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = req.currUser;
    (ctx.request as any).body = req.body ?? {};
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    return next();
  });
  app.use(bouncer.middleware());
  app.use(topicsRouter.routes());
  app.use(indexRouter.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
      method: req.method,
      redirect: "manual",
    });
    return { status: res.status };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

// Intent: a GM's topic ban stops the banned member's post writes on the
// server, not only in the topic page's hidden reply form and Edit button.
// Why it exists: the create-post and revert routes loaded rows without the
// topic's ban list, and cancan read the missing list as "no bans".
// Scenario: the GM bans a player from the quest. The player still holds the
// reply form in a stale tab, and still has a post with revisions there.

describe("POST /topics/:topicSlug/posts", () => {
  const body = { "post-type": "ic", markup: "My character draws her sword." };

  it("creates a reply from a player the GM has not banned", async () => {
    const res = await send({
      method: "POST",
      path: `/topics/${topic.id}-quest/posts`,
      currUser: player,
      body,
    });

    expect(db.createPost).toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(pool.query).toHaveBeenCalled();
  });

  it("refuses a reply from a player the GM banned from the topic", async () => {
    const res = await send({
      method: "POST",
      path: `/topics/${topic.id}-quest/posts`,
      currUser: banned,
      body,
    });

    expect(db.createPost).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });
});

describe("POST /posts/:postId/revisions/:revId/revert", () => {
  const revId = 7;

  it("reverts a post for its author", async () => {
    const res = await send({
      method: "POST",
      path: `/posts/${playerPost.id}/revisions/${revId}/revert`,
      currUser: player,
    });

    expect(db.revs.revertPostRev).toHaveBeenCalledWith(
      player.id,
      playerPost.id,
      revId,
    );
    expect(res.status).toBe(302);
    expect(pool.query).toHaveBeenCalled();
  });

  it("refuses a revert from an author the GM banned from the topic", async () => {
    const res = await send({
      method: "POST",
      path: `/posts/${bannedPost.id}/revisions/${revId}/revert`,
      currUser: banned,
    });

    expect(db.revs.revertPostRev).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });
});
