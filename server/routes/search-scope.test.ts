import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOD_CATEGORY_ID } from "../cancan";
import { pool } from "../db/util.js";
import "../validation";
import router from "./search";

// The repo has no real-database tests, so these read the SQL that GET /search
// sends to the pool.
vi.mock("../db/util.js", () => ({
  pool: { query: vi.fn() },
}));

// Importing the real cache3 starts its refresh loop against the database.
vi.mock("../cache3", () => ({
  default: {
    get: vi.fn((key: string) => (key === "categories" ? [] : {})),
  },
}));

const query = vi.mocked(pool.query) as any;

const member = { id: 1, uname: "Member", slug: "member", role: "member" };
const mod = { id: 2, uname: "Mod", slug: "mod", role: "mod" };

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

// A bare Koa app with only what the search route reads from ctx, as in
// server/routes/images.test.ts.
async function search(currUser: object, qs: string) {
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = currUser;
    ctx.render = async (template: string) => {
      ctx.body = template;
    };
    return next();
  });
  app.use(bouncer.middleware());
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/search?${qs}`, {
      redirect: "manual",
    });
    return res.status;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The capped subquery that ranking and paging read from. A clause outside it
// would still let unreadable rows fill the 1000-row cap.
function innerSubquery(): string {
  expect(query).toHaveBeenCalledTimes(1);
  const sql: string = query.mock.calls[0][0];
  const inner = sql.match(/from \((select .*?)\) as "x"/s)?.[1];
  expect(inner, sql).toBeDefined();
  expect(inner).toContain("limit 1000");
  return inner!;
}

const hiddenTopicClause = /"topics"\."is_hidden" = false/;
const loungeClause = new RegExp(
  `"forums"\\."category_id" <> ${MOD_CATEGORY_ID}`,
);

describe("GET /search", () => {
  // Intent: a member's search never matches lounge posts or posts in hidden
  // topics, so the result list cannot count them.
  // Why it exists: search filtered only hidden posts and printed a "not
  // authorized" line per unreadable match, so a member could test whether
  // staff wrote a word in the mod forum (hunt 261026-0911-030).
  // Scenario: a member searches for a term that a lounge post contains.
  it("leaves lounge forums and hidden topics out of a member's matches", async () => {
    expect(await search(member, "term=dragon")).toBe(200);

    const inner = innerSubquery();
    expect(inner).toMatch(hiddenTopicClause);
    expect(inner).toMatch(loungeClause);
    expect(inner).toMatch(/"posts"\."is_hidden" = false/);
  });

  it("keeps lounge forums and hidden topics in staff matches", async () => {
    expect(await search(mod, "term=dragon")).toBe(200);

    const inner = innerSubquery();
    expect(inner).not.toMatch(hiddenTopicClause);
    expect(inner).not.toMatch(/category_id/);
    // Hidden posts stay out for everyone: nuked spambots' posts are hidden.
    expect(inner).toMatch(/"posts"\."is_hidden" = false/);
  });
});
