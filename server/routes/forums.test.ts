import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cancan from "../cancan";
import * as db from "../db";
import * as forumText from "../forum_text";
import "../validation";
import router from "./forums";

// Discord is configured, so a relay reaches the stubbed client below.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "guild-id",
  HOST: "https://guild.example",
}));

const discordClient = vi.hoisted(() => ({
  listGuildChannels: vi.fn(),
  createMessage: vi.fn(),
}));
vi.mock("../discord/client", () => ({
  default: vi.fn(function () {
    return discordClient;
  }),
}));

vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  loadForumFor: vi.fn(),
}));

// The topic write and its spam screening. Each topic here passes.
vi.mock("../forum_text", () => ({ createTopic: vi.fn() }));

// server/bbcode.js loads cache3 with a CommonJS require that vitest cannot
// resolve to a .ts file, and no test here reads the rendered HTML.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

// The member_relays claim runs against the fake database below, which models
// its SQL. server/db/member_relays.test.ts runs the real SQL on real rows.
vi.mock("../db/util", async (importOriginal) => {
  const util = await importOriginal<typeof import("../db/util")>();
  const query = vi.fn(async (sql: string, params?: unknown[]) =>
    answer(sql, params ?? []),
  );
  const client = { query, release: vi.fn() };
  return {
    ...util,
    pool: { query, connect: vi.fn(async () => client) },
  };
});

////////////////////////////////////////////////////////////
// Fixtures

const INTRO_FORUM_ID = 2;
const introForum = {
  id: INTRO_FORUM_ID,
  title: "Introduce Yourself",
  category_id: 1,
  is_roleplay: false,
  has_tags_enabled: false,
  tag_id: null,
};

const newcomer = {
  id: 7,
  uname: "Newcomer",
  slug: "newcomer",
  role: "member",
  posts_count: 0,
  approved_at: null,
};

////////////////////////////////////////////////////////////
// Fake database

// The database clock, frozen: every claim lands in the same instant.
const NOW = new Date("2026-11-17T12:00:00Z");

type RelayRow = { user_id: number; kind: string; created_at: Date };
let relayRows: RelayRow[] = [];

// Answers the member_relays claim the way Postgres would. Any other query
// throws, so a route that reaches one fails at once.
function answer(sql: string, params: unknown[]) {
  const rows = ((): unknown[] => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(sql)) return [];
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/INSERT INTO member_relays[\s\S]*DO NOTHING/.test(sql)) {
      const [user_id, kind] = params as [number, string];
      if (relayRows.some((r) => r.user_id === user_id && r.kind === kind)) {
        return [];
      }
      relayRows.push({ user_id, kind, created_at: NOW });
      return [{ created_at: NOW }];
    }
    if (/FROM member_relays/.test(sql)) {
      const [kind, , , noteKind] = params as [string, Date, number, string];
      const notes = relayRows.filter((r) => r.kind === noteKind);
      return [
        {
          count: relayRows.filter((r) => r.kind === kind).length,
          last_note_at: notes.length > 0 ? notes.at(-1)!.created_at : null,
        },
      ];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  })();
  return { rows, rowCount: rows.length };
}

let nextTopicId = 100;

beforeEach(() => {
  vi.clearAllMocks();
  relayRows = [];
  discordClient.listGuildChannels.mockResolvedValue([
    { id: "general-id", name: "general" },
    { id: "forum-activity-id", name: "forum-activity" },
  ]);
  discordClient.createMessage.mockResolvedValue({});
  vi.mocked(db.loadForumFor).mockImplementation(async (_viewer, forumId) =>
    forumId === INTRO_FORUM_ID
      ? { kind: "readable", forum: { ...introForum } }
      : { kind: "absent" },
  );
  vi.mocked(forumText.createTopic).mockImplementation(
    async (_writer, input) => ({
      topic: { id: nextTopicId++, title: input.title, forum_id: input.forumId },
      flagged: false,
    }),
  );
});

// The content of each message sent to #general, in order
function generalMessages(): string[] {
  return discordClient.createMessage.mock.calls
    .filter(([channelId]) => channelId === "general-id")
    .map(([, body]) => body.content);
}

// Lets the relay a route started after its response run to the end. Every
// fake here answers at once, so it finishes before the next turn of the event
// loop.
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what the routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts.

async function postTopic(currUser: object, title: string): Promise<number> {
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = currUser;
    (ctx.request as any).body = {
      "forum-id": String(INTRO_FORUM_ID),
      title,
      markup: "Hello, I am new here.",
    };
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    return next();
  });
  app.use(bouncer.middleware());
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${port}/forums/${INTRO_FORUM_ID}-introduce-yourself/topics`,
      { method: "POST", redirect: "manual" },
    );
    return res.status;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

describe("POST /forums/:slug/topics", () => {
  // Intent: a member's Introduce Yourself topic is welcomed in #general once,
  // however many intro topics they post.
  // Why it exists: every intro topic that passed the spam check relayed the
  // member's name and the titled topic link to the public #general, and
  // trusted members skip the check, so one account could flood #general at
  // the post ratelimit (hunt 261117-0852-012).
  // Scenario: a newcomer posts two topics in Introduce Yourself.
  it("welcomes a member's intro in #general only once", async () => {
    expect(await postTopic({ ...newcomer }, "Hi, I am new")).toBe(302);
    expect(await postTopic({ ...newcomer }, "Hi again, still new")).toBe(302);
    await settle();

    const messages = generalMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("**Newcomer** created an Introduce Yourself");
  });
});
