import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cancan from "../cancan";
import * as emailer from "../emailer";
import * as eflags from "../eflags";
import "../validation";
import router from "./convos";

// The convo routes answer "PM system currently disabled" before any check
// unless this flag is on.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  IS_PM_SYSTEM_ONLINE: true,
}));

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

vi.mock("../emailer", () => ({
  sendNewConvoEmails: vi.fn(async () => {}),
}));

vi.mock("../services", () => ({
  default: { discord: { broadcastFirstConvo: vi.fn(async () => {}) } },
}));

// The real write functions in server/db run against this fake pool, so the
// test sees which SQL a send issues. vitest cannot run Postgres here.
vi.mock("../db/util", async (importOriginal) => {
  const util = await importOriginal<typeof import("../db/util")>();
  const query = vi.fn(async (sql: string) => answer(sql));
  const client = { query, release: vi.fn() };
  return {
    ...util,
    pool: { query, connect: vi.fn(async () => client) },
  };
});

////////////////////////////////////////////////////////////
// Fixtures

const alice = {
  id: 1,
  uname: "Alice",
  slug: "alice",
  role: "member",
  posts_count: 1,
  approved_at: null,
};

// Recipients who confirmed their address and kept new-convo mail on, so a
// convo that lands mails each of them.
const bob = {
  id: 2,
  uname: "Bob",
  slug: "bob",
  role: "member",
  email: "bob@example.com",
  email_verified_at: new Date(),
  eflags: eflags.NEW_CONVO,
};
const carol = { ...bob, id: 3, uname: "Carol", slug: "carol" };

// Alice has spent this much in the last hour.
let spent = 0;

const queries: string[] = [];

// Answers each query the way Postgres would for this flow. Unknown SQL throws,
// so a new query in the flow fails the test until it is answered here.
function answer(sql: string) {
  queries.push(sql);
  const rows = (() => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(sql)) return [];
    if (/lower\(u\.uname\) = ANY/.test(sql)) return [{ ...bob }, { ...carol }];
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/SELECT approved_at, posts_count\s+FROM users/.test(sql)) {
      return [{ approved_at: alice.approved_at, posts_count: 1 }];
    }
    if (/DELETE FROM send_spends/.test(sql)) return [];
    if (/SELECT cost, created_at\s+FROM send_spends/.test(sql)) {
      return spent > 0 ? [{ cost: spent, created_at: new Date() }] : [];
    }
    if (/INSERT INTO send_spends/.test(sql)) return [];
    if (/INSERT INTO convos \(/.test(sql)) {
      return [{ id: 99, user_id: alice.id, title: "Hi", pms_count: 0 }];
    }
    if (/INSERT INTO convos_participants/.test(sql)) return [];
    if (/INSERT INTO pms/.test(sql)) return [{ id: 500, convo_id: 99, idx: 0 }];
    if (/INSERT INTO notifications/.test(sql)) return [];
    throw new Error(`unexpected SQL: ${sql}`);
  })();
  return { rows, rowCount: rows.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  spent = 0;
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx, as in
// server/routes/images.test.ts. The authz shim mirrors the one in
// server/index.ts.

async function send(req: { path: string; body: object }) {
  let flash: any;
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = { ...alice };
    (ctx.request as any).body = req.body;
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    await next();
    flash = ctx.flash;
  });
  app.use(bouncer.middleware());
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
      method: "POST",
      redirect: "manual",
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      flash,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

describe("POST /convos", () => {
  const body = { to: "bob, carol", title: "Hi", markup: "Want to RP?" };

  // Intent: a member past their send budget cannot open a convo, and no mail
  // goes out for it.
  // Why it exists: POST /convos had no throttle, so one confirmed account could
  // open convos without limit and mail every recipient who kept the default
  // NEW_CONVO bit through the one SES sender (hunt finding 261026-0911-017).
  // Scenario: Alice, a new member, already spent her whole hourly budget and
  // tries to open a convo with Bob and Carol.
  it("refuses a sender past their budget, with no convo and no mail", async () => {
    spent = 30;

    const res = await send({ path: "/convos", body });

    expect(queries.some((sql) => /INSERT INTO convos \(/.test(sql))).toBe(
      false,
    );
    expect(emailer.sendNewConvoEmails).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.location).toBe("/convos/new?to=bob,carol");
    expect(res.flash.message[0]).toBe("danger");
    expect(res.flash.message[1]).toMatch(/Try again in/);
    // The form refills from these, so the refused message is not lost.
    expect(res.flash.params.fields).toEqual(body);
  });

  it("opens the convo and mails recipients while under budget", async () => {
    const res = await send({ path: "/convos", body });

    expect(queries.some((sql) => /INSERT INTO convos \(/.test(sql))).toBe(true);
    expect(emailer.sendNewConvoEmails).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(res.location).toMatch(/^\/convos\/99/);
  });
});
