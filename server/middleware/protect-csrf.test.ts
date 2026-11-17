import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import Koa, { Context, Next } from "koa";
import { describe, expect, it } from "vitest";

import protectCsrf, { shouldRejectCrossSite } from "./protect-csrf";

const HOST = "www.roleplayerguild.com";
const OWN = "https://www.roleplayerguild.com";

type Headers = { secFetchSite?: string; origin?: string; referer?: string };

// A write to the production host with the given headers.
function rejects(headers: Headers, method = "POST"): boolean {
  return shouldRejectCrossSite({
    method,
    host: HOST,
    secFetchSite: headers.secFetchSite,
    origin: headers.origin,
    referer: headers.referer,
  });
}

describe("shouldRejectCrossSite", () => {
  // Intent: when the browser sends Sec-Fetch-Site, its verdict stands and
  // nothing else is read.
  // Why it exists: the old hostname list admitted every roleplayerguild.com
  // subdomain, including the upload hosts img. and avatars. Their pages are
  // same-site, so Lax cookies ride along, and this gate is all that stops them.
  // Scenario: same-site and cross-site writes are refused whatever Origin
  // says, and a same-origin write passes though its Origin is not the Host.
  it.each([
    [
      "same-site",
      { secFetchSite: "same-site", origin: "https://img.roleplayerguild.com" },
    ],
    [
      "cross-site",
      { secFetchSite: "cross-site", origin: "https://evil.example" },
    ],
    ["an unknown value", { secFetchSite: "bogus", origin: OWN }],
  ])("refuses Sec-Fetch-Site %s", (_name, headers) => {
    expect(rejects(headers)).toBe(true);
  });

  it.each([
    [
      "same-origin, though Origin is not the Host",
      { secFetchSite: "same-origin", origin: "https://evil.example" },
    ],
    ["none", { secFetchSite: "none" }],
  ])("passes Sec-Fetch-Site %s", (_name, headers) => {
    expect(rejects(headers)).toBe(false);
  });

  // Intent: without Sec-Fetch-Site, a write passes only when its Origin, or
  // its Referer when Origin is absent, names the host the request came to.
  // Why it exists: the old suffix match would have admitted a lookalike domain
  // after a one-character slip, and its list trusted staging and localhost in
  // production.
  // Scenario: one row per way an older browser's write can look.
  it.each([
    ["the own Origin", { origin: OWN }],
    ["the own Referer and no Origin", { referer: `${OWN}/topics/1` }],
  ])("passes %s when Sec-Fetch-Site is absent", (_name, headers) => {
    expect(rejects(headers)).toBe(false);
  });

  it.each([
    ["a lookalike Origin", { origin: "https://evilroleplayerguild.com" }],
    ["an upload subdomain", { origin: "https://img.roleplayerguild.com" }],
    ["the staging host", { origin: "https://rpguild-staging.fly.dev" }],
    ["localhost", { origin: "http://localhost:3000" }],
    [
      "Origin null and the own Referer",
      { origin: "null", referer: `${OWN}/x` },
    ],
    ["an unparsable Origin", { origin: "not a url" }],
    [
      "a lookalike in a Referer query",
      { referer: `https://evil.example/?${HOST}` },
    ],
    ["no headers", {}],
  ])("refuses %s when Sec-Fetch-Site is absent", (_name, headers) => {
    expect(rejects(headers)).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("passes %s with no headers", (method) => {
    expect(rejects({}, method)).toBe(false);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("judges %s", (method) => {
    expect(rejects({}, method)).toBe(true);
    expect(rejects({ origin: OWN }, method)).toBe(false);
  });
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app: an optional stub that rewrites ctx.method as methodOverride
// does, the gate, then a handler that records that it ran. Neither
// server/index.ts nor server/middleware/index.ts can be imported here: the
// first starts cache3 and app.listen, and the second loads server/db.
// `init` gets the server's own origin, which matches the Host header fetch
// sends.

async function send(
  init: (own: string) => RequestInit,
  override?: string,
): Promise<{ status: number; reached: boolean }> {
  let reached = false;
  const app = new Koa();
  app.silent = true;
  if (override) {
    app.use(async (ctx: Context, next: Next) => {
      ctx.method = override;
      await next();
    });
  }
  app.use(protectCsrf());
  app.use(async (ctx: Context) => {
    reached = true;
    ctx.status = 200;
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const own = `http://127.0.0.1:${port}`;
    const res = await fetch(`${own}/anything`, init(own));
    return { status: res.status, reached };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("protectCsrf", () => {
  it("answers a refused write with 403 and never runs the next handler", async () => {
    const res = await send(() => ({ method: "POST" }));

    expect(res).toEqual({ status: 403, reached: false });
  });

  it.each([
    ["Sec-Fetch-Site", () => ({ "sec-fetch-site": "same-origin" })],
    ["Origin", (own: string) => ({ origin: own })],
    ["Referer", (own: string) => ({ referer: `${own}/x` })],
  ])("reads %s from the request", async (_name, headers) => {
    const res = await send((own) => ({
      method: "POST",
      headers: headers(own),
    }));

    expect(res).toEqual({ status: 200, reached: true });
  });

  // Intent: the gate judges ctx.method as methodOverride leaves it, the
  // method the router dispatches on.
  // Why it exists: forms send DELETE and PUT as a POST with _method.
  // Scenario: a POST overridden to DELETE is judged as a write. One overridden
  // to GET passes, and it can reach only GET routes, which a plain cross-site
  // link reaches anyway.
  it("judges a POST overridden to DELETE", async () => {
    const res = await send(() => ({ method: "POST" }), "DELETE");

    expect(res).toEqual({ status: 403, reached: false });
  });

  it("passes a POST overridden to GET", async () => {
    const res = await send(() => ({ method: "POST" }), "GET");

    expect(res).toEqual({ status: 200, reached: true });
  });
});

describe("server/index.ts", () => {
  // Intent: the gate is mounted once, at top level, after methodOverride and
  // before the first router.
  // Why it exists: server/index.ts cannot be imported in tests, so nothing
  // else fails if the mount is deleted, made conditional, or moved. After a
  // router, the router answers first. Ahead of methodOverride, the gate judges
  // a method the router does not dispatch on.
  // Scenario: it reads the source, so moving the mounts into a helper fails
  // it too. It retires once a test can import server/index.ts.
  it("mounts protectCsrf once, after methodOverride and before the first router", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.ts"), "utf8");
    function mounts(re: RegExp): number[] {
      return [...src.matchAll(re)].map((m) => m.index);
    }

    const gate = mounts(/^app\.use\(protectCsrf\(\)\);$/gm);
    const override = mounts(/^app\.use\(middleware\.methodOverride\(\)\);$/gm);
    const routers = mounts(/^app\.use\(\w+\.routes\(\)\);$/gm);

    expect(gate).toHaveLength(1);
    expect(override.length).toBeGreaterThan(0);
    expect(routers.length).toBeGreaterThan(0);
    expect(Math.max(...override)).toBeLessThan(gate[0]!);
    expect(gate[0]!).toBeLessThan(Math.min(...routers));
  });
});
