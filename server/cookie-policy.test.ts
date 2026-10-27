import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context } from "koa";
import { describe, expect, it } from "vitest";

import { installCookiePolicy } from "./cookie-policy";

// Installs the policy on a bare Koa app and sends one plain-http request with
// no X-Forwarded-Proto, the way a request reaches Node behind Fly. The
// handler gets the request's ctx.
async function send(
  secure: boolean,
  handler: (ctx: Context) => void,
): Promise<{ status: number; setCookies: string[] }> {
  const app = new Koa();
  app.silent = true;
  installCookiePolicy(app, { secure });
  app.use(async (ctx: Context) => {
    handler(ctx);
    ctx.status = 200;
    ctx.body = "ok";
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    return { status: res.status, setCookies: res.headers.getSetCookie() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function cookieNamed(setCookies: string[], name: string): string {
  const cookie = setCookies.find((c) => c.startsWith(`${name}=`));
  expect(cookie, `no Set-Cookie for ${name}`).toBeDefined();
  return cookie!;
}

describe("installCookiePolicy", () => {
  // Intent: the session cookie goes out Secure, SameSite=Lax and HttpOnly.
  // Why it exists: TLS ends before Node behind Fly, so Koa's default Secure
  // was false and the session cookie had no Secure and no SameSite. One
  // induced plain-http request then carried the session in the clear.
  // Scenario: a login sets sessionId with only expires, as the session
  // routes do.
  it("marks a cookie set with only expires Secure, Lax and HttpOnly", async () => {
    const res = await send(true, (ctx) => {
      ctx.cookies.set("sessionId", "abc", {
        expires: new Date(Date.now() + 60_000),
      });
    });

    expect(res.status).toBe(200);
    const cookie = cookieNamed(res.setCookies, "sessionId");
    expect(cookie).toContain("; secure");
    expect(cookie).toContain("; samesite=lax");
    expect(cookie).toContain("; httponly");
  });

  // Intent: no option a call passes can loosen the policy.
  // Why it exists: cookies 0.9.1 lets the deprecated secureProxy option
  // overwrite Secure after it reads secure, and its types still accept it.
  it("overrides options that try to loosen the policy", async () => {
    const res = await send(true, (ctx) => {
      ctx.cookies.set("loose", "v", {
        secure: false,
        secureProxy: false,
        httpOnly: false,
        sameSite: "none",
      });
    });

    expect(res.status).toBe(200);
    const cookie = cookieNamed(res.setCookies, "loose");
    expect(cookie).toContain("; secure");
    expect(cookie).toContain("; samesite=lax");
    expect(cookie).not.toContain("samesite=none");
    expect(cookie).toContain("; httponly");
  });

  // Intent: a caller may still pass secure: true.
  // Why it exists: cookies 0.9.1 throws "Cannot send secure cookie over
  // unencrypted connection" when its instance thinks the request is http.
  it("accepts secure: true over plain http", async () => {
    const res = await send(true, (ctx) => {
      ctx.cookies.set("strict", "v", { secure: true });
    });

    expect(res.status).toBe(200);
    expect(cookieNamed(res.setCookies, "strict")).toContain("; secure");
  });

  it("clears a cookie with the same attributes", async () => {
    const res = await send(true, (ctx) => {
      ctx.cookies.set("flash", null);
    });

    expect(res.status).toBe(200);
    const cookie = cookieNamed(res.setCookies, "flash");
    expect(cookie).toContain("expires=Thu, 01 Jan 1970");
    expect(cookie).toContain("; secure");
    expect(cookie).toContain("; samesite=lax");
    expect(cookie).toContain("; httponly");
  });

  // Intent: dev on http://localhost gets no Secure, which the browser would
  // drop, but keeps the rest of the policy.
  it("leaves Secure off when the flag is off", async () => {
    const res = await send(false, (ctx) => {
      ctx.cookies.set("sessionId", "abc", { secure: true });
    });

    expect(res.status).toBe(200);
    const cookie = cookieNamed(res.setCookies, "sessionId");
    expect(cookie).not.toContain("secure");
    expect(cookie).toContain("; samesite=lax");
    expect(cookie).toContain("; httponly");
  });

  it("hands out one jar per request with the same set", async () => {
    let first: Context["cookies"] | undefined;
    let second: Context["cookies"] | undefined;
    let firstSet: unknown;
    const res = await send(true, (ctx) => {
      first = ctx.cookies;
      firstSet = first.set;
      second = ctx.cookies;
    });

    expect(res.status).toBe(200);
    expect(second).toBe(first);
    expect(second!.set).toBe(firstSet);
  });
});
