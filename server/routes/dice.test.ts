// Intent: one account's dice campaigns are bounded per hour, and a new
// member's campaign text goes to the spam classifier, whose verdict on it may
// only flag it for review. Runs the dice routes on real rows in a real
// Postgres (server/testing/db.ts).
// Why it exists: POST /campaigns had no budget and no spam check. One
// confirmed account could publish campaign pages, a title and 10k of markup
// with links, on the public /campaigns list as fast as it sent requests (hunt
// 261117-0852-055).

import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Small, so a test reaches a budget with a few requests
const BUDGET = vi.hoisted(() => ({ untrusted: 2, trusted: 4 }));

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  ROW_BUDGET_PER_HOUR: {
    campaign: BUDGET,
    roll: BUDGET,
    album: BUDGET,
  },
}));

vi.mock("../db/util", async (importOriginal) =>
  (await import("../testing/db")).onTestDatabase(
    await importOriginal<typeof import("../db/util")>(),
  ),
);

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest. Nothing here reads rendered html, but the writers
// take only sanitized html.
vi.mock("../bbcode", async () => {
  const { sanitizeUserHtml } = await import("../user_html");
  return { default: (markup: string) => sanitizeUserHtml(markup) };
});
vi.mock("../services/antispam/claude", () => ({
  default: { analyze: vi.fn(), probe: vi.fn() },
}));
vi.mock("../services/discord", () => ({
  broadcastAutoNuke: vi.fn(async () => {}),
  broadcastClassifierFailing: vi.fn(async () => {}),
  broadcastSpamReview: vi.fn(async () => {}),
  relayOnce: vi.fn(async () => {}),
}));

import * as cancan from "../cancan";
import { pool } from "../db/util";
import { answerRefusals } from "../middleware/refusals";
import claude, { type AnalyzeResult } from "../services/antispam/claude";
import {
  broadcastAutoNuke,
  broadcastSpamReview,
  relayOnce,
} from "../services/discord";
import { closeTestDatabase, emptyTables } from "../testing/db";
import "../validation";
import router from "./dice";

const analyze = vi.mocked(claude.analyze);

beforeEach(async () => {
  vi.clearAllMocks();
  analyze.mockResolvedValue(verdict(false, 0.99));
  await emptyTables();
});
afterAll(closeTestDatabase);

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

// A member with no posts, so new to the spam check (server/trust.ts)
async function createMember(uname: string) {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO users (uname, digest, email, slug)
    VALUES ($1, '', $1 || '@example.com', $1)
    RETURNING id
  `,
    [uname],
  );
  return { id: rows[0]!.id, uname, slug: uname, role: "member" };
}

async function campaignIds(userId: number): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM campaigns WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return rows.map((row) => row.id);
}

// Lets the screening a route started after its response run to the end.
// Every stand-in here answers at once, so it finishes before the next turn of
// the event loop.
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with the app's real refusal answer and only what the routes
// read from ctx. server/index.ts cannot be imported here: loading it starts
// cache3 and app.listen. The authz shim mirrors the one in server/index.ts.
// The flash setter records what the handler set, since there is no flash
// middleware.

async function post(currUser: object, path: string, body: object) {
  let flash: { message: [string, string] } | undefined;
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = currUser;
    (ctx.request as any).body = body;
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    Object.defineProperty(ctx, "flash", {
      get: () => flash,
      set: (value) => {
        flash = value;
      },
    });
    return next();
  });
  app.use(bouncer.middleware());
  app.use(answerRefusals());
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      redirect: "manual",
    });
    return { status: res.status, flash };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

describe("POST /campaigns", () => {
  // Scenario: a new member creates campaigns in a loop, one more than the
  // hour allows.
  it("refuses a new member's campaign past the hourly budget and writes nothing", async () => {
    const member = await createMember("newbie");

    const flashes = [];
    for (let i = 0; i <= BUDGET.untrusted; i++) {
      const res = await post(member, "/campaigns", {
        title: `Campaign ${i}`,
        markup: "",
      });
      expect(res.status).toBe(302);
      flashes.push(res.flash?.message);
    }

    expect(flashes.slice(0, BUDGET.untrusted)).toEqual(
      Array(BUDGET.untrusted).fill(["success", "Dice campaign created"]),
    );
    expect(flashes.at(-1)).toEqual([
      "danger",
      expect.stringMatching(/dice campaigns/),
    ]);
    expect(await campaignIds(member.id)).toHaveLength(BUDGET.untrusted);
  });

  // Scenario: a new member's first campaign is a link page the classifier
  // calls spam with the confidence that nukes a post's author.
  it("screens a new member's campaign, and only flags spam for review", async () => {
    analyze.mockResolvedValue(verdict(true, 0.95));
    const member = await createMember("spammer");

    const res = await post(member, "/campaigns", {
      title: "Cheap coins",
      markup: "Buy at spam.example",
    });
    await settle();

    expect(res.status).toBe(302);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(JSON.parse(analyze.mock.calls[0]![0].take())).toEqual({
      username: "spammer",
      title: "Cheap coins",
      body: "Buy at spam.example",
    });
    const [campaignId] = await campaignIds(member.id);
    expect(vi.mocked(broadcastSpamReview)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(broadcastSpamReview)).toHaveBeenCalledWith(
      expect.objectContaining({ id: member.id }),
      `/campaigns/${campaignId}`,
      expect.objectContaining({ isSpam: true }),
    );
    expect(vi.mocked(broadcastAutoNuke)).not.toHaveBeenCalled();
    expect(vi.mocked(relayOnce)).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      `SELECT role, is_nuked FROM users WHERE id = $1`,
      [member.id],
    );
    expect(rows).toEqual([{ role: "member", is_nuked: false }]);
  });
});
