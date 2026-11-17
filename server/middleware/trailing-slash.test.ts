import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import koaBetterStatic from "@ladjs/koa-better-static";
import Koa, { Context } from "koa";
import { describe, expect, it, vi } from "vitest";

// server/middleware/index.ts holds methodOverride and loads server/db; stubbed
// so no pool is built.
vi.mock("../db", () => ({}));

import { bodyParser } from "./body";
import { methodOverride } from "./index";
import protectCsrf from "./protect-csrf";
import { trailingSlash } from "./trailing-slash";

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app over node:http: optionally the middleware that runs ahead of
// trailingSlash in server/index.ts and can change what it sees, then
// trailingSlash, then a handler that records that it ran. server/index.ts
// cannot be imported here: it starts cache3 and app.listen.

type Init = {
  method: string;
  // Sent exactly as written. fetch would parse it as a URL first and turn a
  // backslash into a slash.
  path: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
  // Mount the static server, body parser, methodOverride and protectCsrf in
  // front, in their order in server/index.ts.
  chain?: boolean;
};

type Answer = {
  status: number;
  location: string | undefined;
  reached: boolean;
  // The origin the request went to, which a browser resolves Location against.
  own: string;
};

async function send(init: Init): Promise<Answer> {
  let reached = false;
  const app = new Koa();
  app.silent = true;
  if (init.chain) {
    app.use(koaBetterStatic(path.join(__dirname, "..", "..", "public")));
    app.use(bodyParser());
    app.use(methodOverride());
    app.use(protectCsrf());
  }
  app.use(trailingSlash());
  // Like a route, it sets only a body, so a status set ahead of it stands.
  app.use(async (ctx: Context) => {
    reached = true;
    ctx.body = "page";
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: init.method,
          path: init.path,
          headers: init.headers,
          agent: false,
        },
        resolve,
      );
      req.on("error", reject);
      req.end(init.body);
    });
    res.resume();
    await new Promise((resolve) => res.on("end", resolve));
    return {
      status: res.statusCode!,
      location: res.headers.location,
      reached,
      own: `http://127.0.0.1:${port}`,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("trailingSlash", () => {
  // Intent: a path with a trailing slash redirects to the same path without
  // it, and the route behind does not run as well.
  // Why it exists: the old middleware set the redirect and still called next,
  // so the matched route ran on every redirect.
  // Scenario: GET and HEAD with a query string.
  it.each(["GET", "HEAD"])("redirects %s /users/x/ to /users/x", async (m) => {
    const res = await send({ method: m, path: "/users/x/?a=1" });

    expect(res).toMatchObject({ status: 301, location: "/users/x?a=1" });
    expect(res.reached).toBe(false);
  });

  // Intent: the redirect always names a path on this site, whatever the
  // request path holds.
  // Why it exists: the target was the path minus its last slash, so
  // //evil.example/ answered 301 //evil.example, and /\evil.example/ answered
  // 301 /\evil.example. Browsers read both as another host (hunt
  // 261117-0852-054).
  // Scenario: each way a path can start that a browser reads as a host.
  it.each([
    ["//evil.example/", "/evil.example"],
    ["/\\evil.example/", "/evil.example"],
    ["/\\/\\evil.example/a/", "/evil.example/a"],
    ["///evil.example/?q=1", "/evil.example?q=1"],
    ["//", "/"],
  ])("redirects GET %s to %s", async (from, to) => {
    const res = await send({ method: "GET", path: from });

    expect(res).toMatchObject({ status: 301, location: to });
    expect(res.reached).toBe(false);
  });

  // Intent: only GET and HEAD redirect; every other method reaches the route.
  // Why it exists: the router matches a path with or without its trailing
  // slash, and a 301 makes a browser drop a POST body.
  // Scenario: a preflight and a form post.
  it.each(["OPTIONS", "POST"])("passes %s /users/x/ through", async (m) => {
    const res = await send({ method: m, path: "/users/x/" });

    expect(res).toMatchObject({ status: 200, reached: true });
    expect(res.location).toBeUndefined();
  });

  it("passes GET / through", async () => {
    const res = await send({ method: "GET", path: "/" });

    expect(res).toMatchObject({ status: 200, reached: true });
    expect(res.location).toBeUndefined();
  });

  // Intent: no request reaches the redirect with a target off this site,
  // through the middleware that runs ahead of it in server/index.ts.
  // Why it exists: the static server refuses a GET for //evil.example/, but
  // not a POST, and methodOverride turns a POST with _method=GET into a GET,
  // which protectCsrf passes. So another site's form could send a member to
  // //evil.example with a cached 301.
  // Scenario: a cross-site form post with _method=GET.
  it("keeps a cross-site POST overridden to GET on this site", async () => {
    const res = await send({
      chain: true,
      method: "POST",
      path: "//evil.example/",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "_method=GET",
    });

    expect(new URL(res.location!, res.own).origin).toBe(res.own);
    expect(res).toMatchObject({ status: 301, location: "/evil.example" });
    expect(res.reached).toBe(false);
  });
});
