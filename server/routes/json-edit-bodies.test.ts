import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { describe, expect, it, vi } from "vitest";

// Intent: an editor's save gets back only the fields its page reads, never the
// row the database returned.
// Why it exists: PUT /api/users/:id/bio sent the whole users row, so a mod who
// edited a member's bio got that member's bcrypt digest, email and
// registration IP. PUT /api/posts/:id sent the whole posts row, so a member
// co-GM who saved the GM's zeroth post got the GM's posting IP, which
// READ_USER_IP denies to every member (finding 261026-0911-025).
// Scenario: a mod saves a member's bio, a co-GM saves the GM's zeroth post with
// and without a change, and a member saves their own PM.

vi.mock("../db", () => ({
  findUserById: vi.fn(),
  updateUserBio: vi.fn(),
  findPost: vi.fn(),
  updatePost: vi.fn(),
  findPmWithConvo: vi.fn(),
  updatePm: vi.fn(),
}));
// Imported by the route modules; stubbed so no pool or refresh loop is built.
vi.mock("../db/util", () => ({ pool: {}, withPgPoolTransaction: vi.fn() }));
vi.mock("../cache3", () => ({ default: { requestUpdate: vi.fn() } }));
// server/bbcode.js require()s the TypeScript cache3 module, which vitest's
// CommonJS loader cannot resolve.
vi.mock("../bbcode", () => ({ default: () => "<p>saved</p>" }));
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  IS_PM_SYSTEM_ONLINE: true,
}));

import * as db from "../db";
import * as cancan from "../cancan";
import "../validation";
import { responseEdge } from "../middleware/response-edge";
import convosRouter from "./convos";
import topicsRouter from "./topics";
import usersRouter from "./users";

////////////////////////////////////////////////////////////
// Fixtures

const mod = { id: 2, uname: "Mod", slug: "mod", role: "mod" };
const gm = { id: 104, uname: "Gm", slug: "gm", role: "member" };
const coGm = { id: 105, uname: "CoGm", slug: "cogm", role: "member" };

// A users row (u.*) with the columns no editor may see.
const memberRow = {
  id: 1,
  uname: "Member",
  slug: "member",
  role: "member",
  posts_count: 10,
  bio_markup: "Old bio",
  bio_html: "<p>Old bio</p>",
  digest: "$2b$10$abcdefghijklmnopqrstuv",
  email: "member@example.test",
  registration_ip: "203.0.113.7",
  created_at: new Date("2026-08-01T00:00:00Z"),
};

const ZEROTH_MARKUP = "The GM's opening post for this roleplay.";

// db.findPost rows: p.*, the topic, the forum and the topic's banned_ids. The
// zeroth post belongs to the GM and carries the GM's posting IP.
function zerothPostRow() {
  return {
    id: 900,
    idx: -1,
    user_id: gm.id,
    topic_id: 7,
    type: "ooc",
    markup: ZEROTH_MARKUP,
    html: "<p>opening</p>",
    ip_address: "198.51.100.4",
    is_hidden: false,
    created_at: new Date("2026-09-01T00:00:00Z"),
    updated_at: null,
    topic: {
      id: 7,
      title: "A roleplay",
      user_id: gm.id,
      forum_id: 4,
      co_gm_ids: [coGm.id],
      is_hidden: false,
    },
    forum: { id: 4, category_id: 2, title: "Casual Roleplay" },
    banned_ids: [],
  };
}

// db.findPmWithConvo rows: pms.* and the convo.
function pmRow() {
  return {
    id: 50,
    convo_id: 8,
    user_id: coGm.id,
    markup: "Old PM",
    html: "<p>Old PM</p>",
    legacy_html: null,
    ip_address: "198.51.100.9",
    created_at: new Date("2026-09-02T00:00:00Z"),
    convo: { id: 8, title: "Plans", participants: [coGm, gm] },
  };
}

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with the real response edge and only what these routes read
// from ctx. server/index.ts cannot be imported here: loading it starts cache3
// and app.listen. The authz shim mirrors the one in server/index.ts.

async function put(path: string, currUser: object, body: object) {
  const app = new Koa();
  app.silent = true;
  app.use(responseEdge());
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = currUser;
    (ctx.request as any).body = body;
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    return next();
  });
  app.use(bouncer.middleware());
  app.use(usersRouter.routes());
  app.use(topicsRouter.routes());
  app.use(convosRouter.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "PUT",
    });
    // Parsed from text: the editors ask jQuery for JSON whatever the type.
    return { status: res.status, json: JSON.parse(await res.text()) };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

describe("JSON edit endpoints", () => {
  it("send a mod only the bio fields of the member they edited", async () => {
    vi.mocked(db.findUserById).mockResolvedValue({ ...memberRow } as any);
    vi.mocked(db.updateUserBio).mockResolvedValue({
      ...memberRow,
      bio_markup: "New bio",
      bio_html: "<p>saved</p>",
    } as any);

    const res = await put(`/api/users/${memberRow.id}/bio`, mod, {
      markup: "New bio",
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      id: memberRow.id,
      bio_markup: "New bio",
      bio_html: "<p>saved</p>",
    });
  });

  it.each([
    ["unchanged", ZEROTH_MARKUP, "<p>opening</p>"],
    ["changed", ZEROTH_MARKUP + " Now with more.", "<p>saved</p>"],
  ])(
    "send a co-GM only the post fields when the GM's zeroth post is %s",
    async (_label, markup, html) => {
      vi.mocked(db.findPost).mockResolvedValue(zerothPostRow());
      const { topic: _topic, forum: _forum, ...columns } = zerothPostRow();
      vi.mocked(db.updatePost).mockResolvedValue({
        ...columns,
        markup,
        html: "<p>saved</p>",
      } as any);

      const res = await put("/api/posts/900", coGm, { markup });

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ id: 900, html });
    },
  );

  it("send a PM's author only the PM fields", async () => {
    vi.mocked(db.findPmWithConvo).mockResolvedValue(pmRow() as any);
    const { convo: _convo, ...columns } = pmRow();
    vi.mocked(db.updatePm).mockResolvedValue({
      ...columns,
      markup: "New PM",
      html: "<p>saved</p>",
    } as any);

    const res = await put("/api/pms/50", coGm, { markup: "New PM" });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 50, html: "<p>saved</p>" });
  });
});
