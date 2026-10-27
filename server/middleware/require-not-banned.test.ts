import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import { describe, expect, it } from "vitest";

import {
  BANNED_MESSAGE,
  isBanGateExemptRoute,
  requireNotBanned,
} from "./require-not-banned";

const banned = { id: 1, uname: "Banned", role: "banned" };
const member = { id: 2, uname: "Member", role: "member" };

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app: a stub that sets ctx.currUser and echoes ctx.flash into a
// header, then the gate, then a handler that answers 200 for any request the
// gate lets through. server/index.ts cannot be imported here: loading it
// starts cache3 and app.listen.

async function send(user: unknown, method: string, path: string) {
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = user;
    await next();
    if (ctx.flash) ctx.set("x-flash", JSON.stringify(ctx.flash));
  });
  app.use(requireNotBanned());
  app.use(async (ctx: Context) => {
    ctx.status = 200;
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      redirect: "manual",
    });
    const flash = res.headers.get("x-flash");
    return {
      status: res.status,
      location: res.headers.get("location"),
      flash: flash ? JSON.parse(flash) : null,
      body: await res.text(),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

////////////////////////////////////////////////////////////

describe("requireNotBanned", () => {
  // Intent: a banned user's writes stop at the gate, whatever the route checks.
  // Why it exists: each route had to remember its own banned check, and
  // several forgot, so a banned GM could change co-GMs and tags, hide the 0th
  // post, a banned forum mod could change topic status, and the feedback route
  // checked a field users do not have (hunt 261026-0911-028).
  // Scenario: a banned user sends each write. POST /users is refused too, so a
  // banned session cannot register a new account without logging out first.
  it.each([
    ["POST", "/topics/1-x/co-gms"],
    ["DELETE", "/topics/1-x/co-gms/y"],
    ["PUT", "/topics/1-x/tags"],
    ["PUT", "/topics/1-x/status"],
    ["POST", "/posts/1/hide"],
    ["POST", "/current-feedback-topic/replies"],
    ["POST", "/users"],
  ])("sends a banned user's %s %s home with a flash", async (method, path) => {
    const res = await send(banned, method, path);

    expect(res.status).toBe(302);
    expect(res.location).toBe("/");
    expect(res.flash).toEqual({ message: ["danger", BANNED_MESSAGE] });
  });

  it("answers a banned user's /api/ write with 403", async () => {
    const res = await send(banned, "DELETE", "/api/me/notifications/1");

    expect(res.status).toBe(403);
    expect(res.body).toBe(BANNED_MESSAGE);
  });

  // The self-service writes a banned user could do before the gate existed.
  // Each entry on the allowlist has a case here, so a wrong pattern shows up
  // as a failure rather than as a user bounced home.
  it.each([
    ["POST", "/me/logout"],
    ["POST", "/sessions"],
    ["POST", "/forgot"],
    ["POST", "/reset-password"],
    ["PUT", "/me/email"],
    ["POST", "/api/verify-email"],
    ["DELETE", "/me/notifications"],
    ["DELETE", "/me/notifications/convos"],
    ["DELETE", "/me/subscriptions/1-x"],
    ["POST", "/me/subscriptions/mass-action"],
    ["DELETE", "/me/convos/trash"],
    ["DELETE", "/me/convos"],
    ["POST", "/me/convos/undelete-all"],
    ["POST", "/me/convos/move"],
    ["DELETE", "/convos/5"],
    ["PUT", "/convos/5/folder"],
    ["PUT", "/me/active-trophy"],
    ["DELETE", "/me/active-trophy"],
    ["DELETE", "/me/current-status"],
  ])("lets a banned user's %s %s through", async (method, path) => {
    const res = await send(banned, method, path);

    expect(res.status).toBe(200);
    expect(res.flash).toBeNull();
  });

  it.each(["GET", "HEAD", "OPTIONS"])(
    "lets a banned user's %s through",
    async (method) => {
      const res = await send(banned, method, "/topics/1-x/co-gms");

      expect(res.status).toBe(200);
    },
  );

  it("does not gate members or guests", async () => {
    for (const user of [member, undefined]) {
      const res = await send(user, "POST", "/topics/1-x/co-gms");

      expect(res.status).toBe(200);
      expect(res.flash).toBeNull();
    }
  });

  // Matching must be exact, not startsWith/includes: either would let a
  // banned user reach an arbitrary route by extending an allowlisted one.
  it.each([
    ["POST", "/me/logout/extra"],
    ["POST", "/xme/logout"],
    ["DELETE", "/convos/5/extra"],
    ["PUT", "/convos/5/folder/extra"],
    ["DELETE", "/me/subscriptions/1-x/extra"],
  ])(
    "refuses %s %s, which only extends an allowed route",
    async (method, path) => {
      const res = await send(banned, method, path);

      expect(res.status).toBe(302);
    },
  );
});

describe("isBanGateExemptRoute", () => {
  // Pins the caller's contract: ctx.method arrives uppercase, so nothing here
  // lowercases and a lowercase method is simply not a match. It calls the
  // predicate because no request reaches the gate with a lowercase method.
  it("expects methods to arrive uppercase", () => {
    expect(isBanGateExemptRoute({ method: "post", path: "/me/logout" })).toBe(
      false,
    );
    expect(isBanGateExemptRoute({ method: "get", path: "/topics" })).toBe(
      false,
    );
  });
});
