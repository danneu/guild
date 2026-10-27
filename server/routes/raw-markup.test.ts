import http from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";

import Koa, { Context, Next } from "koa";
import Router from "@koa/router";
import nunjucksRender from "koa-nunjucks-render";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  findPostById: vi.fn(),
  revs: { getPostRev: vi.fn(), getPostRevMarkup: vi.fn() },
}));
// Imported by the routes module; stubbed so no pool or refresh loop is built,
// and so server/bbcode.js never runs its server require() calls, which Node
// cannot resolve to .ts files under vitest.
vi.mock("../cache3", () => ({ default: {} }));
vi.mock("../db/util.js", () => ({ pool: {} }));
vi.mock("../bbcode", () => ({ default: vi.fn() }));

import * as db from "../db";
import indexRoutes from "./index";
import {
  retypeUnrenderedHtml,
  trustRendered,
} from "../middleware/html-only-from-views";

// Intent: member-written markup never reaches a browser as HTML. The raw
// endpoints answer with text/plain and the markup byte for byte, and only a
// view's output keeps the text/html type.
// Why it exists: GET /posts/:id/raw, GET /pms/:id/raw and the revision raw page
// sent stored markup as text/html (Koa sniffs a string body that starts with
// "<"; the revision page set the type itself), so a post could run script on
// the forum origin for whoever opened the link (finding 261026-0911-003).
// Scenario: a member posts this markup and links a mod to its raw view.
const MARKUP = "<img src=x onerror=alert(1)>";
const REV_HTML = "<p>rendered revision</p>";
const PLAIN = "text/plain; charset=utf-8";

vi.mocked(db.findPostById).mockResolvedValue({ id: 1 } as any);
vi.mocked(db.revs.getPostRev).mockResolvedValue({
  id: 2,
  post_id: 1,
  html: REV_HTML,
} as any);
vi.mocked(db.revs.getPostRevMarkup).mockResolvedValue(MARKUP);

// Handlers with the same shape as routes that live on the router in
// server/index.ts, which cannot be imported without booting the app, plus the
// other ways a handler can hand the response an HTML type.
const shapes = new Router();
shapes.get("/posts/:id/raw", (ctx: Context) => {
  ctx.body = MARKUP;
});
shapes.get("/type-then-body", (ctx: Context) => {
  ctx.type = "html";
  ctx.body = MARKUP;
});
shapes.get("/body-then-type", (ctx: Context) => {
  ctx.body = MARKUP;
  ctx.type = "html";
});
shapes.get("/html-buffer", (ctx: Context) => {
  ctx.type = "html";
  ctx.body = Buffer.from(MARKUP);
});
shapes.get("/render-then-overwrite", async (ctx: Context) => {
  await ctx.render("show_post_rev", {
    post: { id: 1 },
    rev: { id: 2, url: "/posts/1/revisions/2", html: REV_HTML },
  });
  ctx.body = MARKUP;
});
shapes.get("/redirect", (ctx: Context) => {
  ctx.redirect("/posts/1");
});
shapes.get("/json", (ctx: Context) => {
  ctx.body = { markup: MARKUP };
});

// Mirrors the order server/index.ts mounts these in.
const app = new Koa();
app.use(retypeUnrenderedHtml());
app.use(
  trustRendered(
    nunjucksRender(join(__dirname, "..", "..", "views"), { ext: ".html" }),
  ),
);
app.use((ctx: Context, next: Next) => {
  // A mod: the revision routes let staff through without assertAuthorized.
  ctx.currUser = { id: 9, role: "mod" };
  return next();
});
app.use(indexRoutes.routes());
app.use(shapes.routes());

const server = http.createServer(app.callback());
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Browsers send Accept: text/html on navigation; Koa's redirect keys on it.
function get(path: string) {
  return fetch(origin + path, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
}

describe("raw markup endpoints", () => {
  it("serve a post's markup as plain text, unchanged", async () => {
    const res = await get("/posts/1/raw");
    expect(res.headers.get("content-type")).toBe(PLAIN);
    // The quote and edit buttons read this body back as post source.
    expect(await res.text()).toBe(MARKUP);
  });

  it("serve a revision's markup as plain text, unchanged", async () => {
    const res = await get("/posts/1/revisions/2/raw");
    expect(res.headers.get("content-type")).toBe(PLAIN);
    expect(await res.text()).toBe(MARKUP);
  });

  it("still serve the revision page as HTML from its view", async () => {
    const res = await get("/posts/1/revisions/2");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain(REV_HTML);
    expect(body).toContain('href="/posts/1/revisions/2/raw"');
  });
});

describe("retypeUnrenderedHtml", () => {
  it.each([
    ["a body typed html before it is set", "/type-then-body"],
    ["a body typed html after it is set", "/body-then-type"],
    ["an html-typed Buffer", "/html-buffer"],
    ["a view's output the handler overwrote", "/render-then-overwrite"],
  ])("sends %s as plain text", async (_label, path) => {
    const res = await get(path);
    expect(res.headers.get("content-type")).toBe(PLAIN);
    expect(await res.text()).toBe(MARKUP);
  });

  it("sends a redirect's body as plain text and keeps its Location", async () => {
    const res = await get("/redirect");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/posts/1");
    expect(res.headers.get("content-type")).toBe(PLAIN);
  });

  it("leaves a JSON body alone", async () => {
    const res = await get("/json");
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await res.json()).toEqual({ markup: MARKUP });
  });
});
