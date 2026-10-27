import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cancan from "../cancan";
import { pool } from "../db/util";
import "../validation";
import forumsRouter from "./forums";
import subscriptionsRouter from "./subscriptions";
import topicsRouter from "./topics";

// Intent: a route that loads a topic or forum by id says nothing about a row
// the viewer may not read -- not even its title in a slug redirect.
// Why it exists: canonical-slug redirects ran before READ_TOPIC/READ_FORUM
// (and first-unread and unsubscribe never checked read at all), so walking
// sequential ids put every Lexus Lounge and hidden title in a Location header.
// Scenario: a guest requests id-only URLs for a staff topic, a hidden topic and
// a staff forum; a member unsubscribes from a staff topic by id.

// The repo has no real-database tests. This stub answers the by-id topic and
// forum queries like the real ones, and every other query with no rows. A row
// carries its forum's mods only when the SQL selects them from forum_mods.
vi.mock("../db/util", () => ({
  pool: { query: vi.fn() },
  maybeOneRow: (res: { rows: unknown[] }) => res.rows[0],
}));

// server/bbcode.js require()s the TypeScript cache3 module, which vitest's
// CommonJS loader cannot resolve. No route under test renders BBCode.
vi.mock("../bbcode", () => ({ default: vi.fn() }));

////////////////////////////////////////////////////////////
// Fixtures

const loungeForum = { id: 10, title: "Mod Forum", category_id: 4 };
const publicForum = { id: 3, title: "Free Roleplay", category_id: 2 };
const forums = [loungeForum, publicForum];

function topicFixture(props: { id: number; title: string; forum_id: number }) {
  return {
    user_id: 50,
    co_gm_ids: [],
    is_roleplay: true,
    is_hidden: false,
    is_closed: false,
    ooc_posts_count: 1,
    ic_posts_count: 0,
    char_posts_count: 0,
    latest_ooc_post_id: 9000 + props.id,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...props,
  };
}

const loungeTopic = topicFixture({
  id: 123,
  title: "Should we ban Alice",
  forum_id: loungeForum.id,
});
const hiddenTopic = {
  ...topicFixture({ id: 124, title: "Spam for Bob", forum_id: publicForum.id }),
  is_hidden: true,
};
const publicTopic = topicFixture({
  id: 125,
  title: "A visible roleplay",
  forum_id: publicForum.id,
});
const topics = [loungeTopic, hiddenTopic, publicTopic];

const member = { id: 1, uname: "Member", slug: "member", role: "member" };
const mod = { id: 2, uname: "Mod", slug: "mod", role: "mod" };

// Fresh copies, because the presenters mutate what the loaders return.
function forumRow(forum: (typeof forums)[number]) {
  return {
    ...forum,
    child_forum: null,
    parent_forum: null,
    child_forums: [],
    sibling_forums: [],
  };
}

// No forum here has mods
function modsFor(sql: string) {
  return /FROM forum_mods\b/.test(sql) ? { mods: [] } : {};
}

function topicRow(sql: string, topic: (typeof topics)[number]) {
  const forum = forums.find((f) => f.id === topic.forum_id)!;
  return {
    ...topic,
    co_gm_ids: [...topic.co_gm_ids],
    forum: { ...forum },
    ...modsFor(sql),
  };
}

// The id is the param named in the `WHERE t.id = $n` or `WHERE f.id = $n`
// clause, because the loaders bind it at different positions.
function answer(sql: string, params: unknown[] = []) {
  const byTopicId = /FROM topics t\b[\s\S]*WHERE t\.id = \$(\d+)/.exec(sql);
  if (byTopicId) {
    const id = Number(params[Number(byTopicId[1]) - 1]);
    const topic = topics.find((t) => t.id === id);
    return { rows: topic ? [topicRow(sql, topic)] : [], rowCount: 0 };
  }
  const byForumId = /FROM forums f\b[\s\S]*WHERE f\.id = \$(\d+)/.exec(sql);
  if (byForumId) {
    const id = Number(params[Number(byForumId[1]) - 1]);
    const forum = forums.find((f) => f.id === id);
    return { rows: forum ? [forumRow(forum)] : [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
}

beforeEach(() => {
  vi.mocked(pool.query).mockReset();
  vi.mocked(pool.query).mockImplementation((async (
    sql: string,
    params?: unknown[],
  ) => answer(sql, params)) as any);
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts, so a denied check is a 404 too.

type Req = {
  method: "GET" | "DELETE";
  path: string;
  currUser: object | null;
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
    ctx.render = async (template: string) => {
      ctx.body = template;
    };
    return next();
  });
  app.use(bouncer.middleware());
  app.use(topicsRouter.routes());
  app.use(forumsRouter.routes());
  app.use(subscriptionsRouter.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
      method: req.method,
      redirect: "manual",
    });
    return { status: res.status, location: res.headers.get("location") };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

describe("a guest walking ids", () => {
  // The router folds case and decodes params, so these reach the tab route
  // with slug "123" too.
  it.each([
    ["the tab of a staff topic", "/topics/123/ooc", "should-we-ban-alice"],
    ["an upper-case tab path", "/TOPICS/123/ooc", "should-we-ban-alice"],
    ["a percent-encoded id", "/topics/%31%32%33/ooc", "should-we-ban-alice"],
    [
      "first-unread of a staff topic",
      "/topics/123/ooc/first-unread",
      "should-we-ban-alice",
    ],
    ["the tab of a hidden topic", "/topics/124/ooc", "spam-for-bob"],
    [
      "first-unread of a hidden topic",
      "/topics/124/ooc/first-unread",
      "spam-for-bob",
    ],
    ["a staff forum", "/forums/10", "mod-forum"],
  ])("gets a 404 and no title for %s", async (_label, path, titleSlug) => {
    const res = await send({ method: "GET", path, currUser: null });

    expect(res.location ?? "").not.toContain(titleSlug);
    expect(res.status).toBe(404);
  });

  it("is still sent to the canonical slug of what it may read", async () => {
    await expect(
      send({ method: "GET", path: "/topics/125/ooc", currUser: null }),
    ).resolves.toEqual({
      status: 301,
      location: "/topics/125-a-visible-roleplay",
    });
    await expect(
      send({ method: "GET", path: "/forums/3", currUser: null }),
    ).resolves.toEqual({ status: 301, location: "/forums/3-free-roleplay" });
    await expect(
      send({
        method: "GET",
        path: "/topics/125/ooc/first-unread",
        currUser: null,
      }),
    ).resolves.toEqual({
      status: 302,
      location: "/topics/125-a-visible-roleplay",
    });
  });
});

describe("a reader of a staff topic", () => {
  it("is sent to its canonical slug", async () => {
    await expect(
      send({ method: "GET", path: "/topics/123/ooc", currUser: mod }),
    ).resolves.toEqual({
      status: 301,
      location: "/topics/123-should-we-ban-alice",
    });
  });
});

describe("DELETE /me/subscriptions/:topicSlug", () => {
  const body = { "return-to-topic": "true" };

  it("returns a member to the id-only topic url, not its title", async () => {
    await expect(
      send({
        method: "DELETE",
        path: "/me/subscriptions/123",
        currUser: member,
        body,
      }),
    ).resolves.toEqual({ status: 302, location: "/topics/123" });
  });

  it("unsubscribes from a topic id that no longer exists", async () => {
    await expect(
      send({
        method: "DELETE",
        path: "/me/subscriptions/999",
        currUser: member,
        body,
      }),
    ).resolves.toEqual({ status: 302, location: "/topics/999" });
  });
});
