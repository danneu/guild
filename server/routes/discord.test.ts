import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import router from "./discord";

// The router builds both clients when the module loads, so the stubs must be
// constructors and must exist before the import above runs.
const mocks = vi.hoisted(() => {
  const authorizeURL = vi.fn();
  const getToken = vi.fn();
  const listRoles = vi.fn();
  const getUser = vi.fn();
  const getGuildMember = vi.fn();
  const addGuildMember = vi.fn();
  return {
    authorizeURL,
    getToken,
    listRoles,
    getUser,
    getGuildMember,
    addGuildMember,
    AuthorizationCode: vi.fn(function () {
      return { authorizeURL, getToken };
    }),
    DiscordClient: vi.fn(function () {
      return { listRoles, getUser, getGuildMember, addGuildMember };
    }),
  };
});

vi.mock("simple-oauth2", () => ({
  AuthorizationCode: mocks.AuthorizationCode,
}));

vi.mock("../discord/client", () => ({ default: mocks.DiscordClient }));

// The router registers no routes unless Discord is configured.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  IS_DISCORD_CONFIGURED: true,
  DISCORD_APP_CLIENTID: "client-id",
  DISCORD_APP_CLIENTSECRET: "client-secret",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_BOT_TOKEN: "bot-token",
  HOST: "https://guild.example",
}));

const admin = { id: 1, uname: "Admin", slug: "admin", role: "admin" };

// The stubs answer like Discord does for a code that redeems, so a request
// that gets past the state check goes all the way to adding a guild member.
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeURL.mockReturnValue("https://discord.com/oauth2/authorize");
  mocks.getToken.mockResolvedValue({ token: { access_token: "access-token" } });
  mocks.listRoles.mockResolvedValue([
    { id: "admin-role-id", name: "Admin" },
    { id: "staff-role-id", name: "Staff" },
    { id: "member-role-id", name: "Member" },
  ]);
  mocks.getUser.mockResolvedValue({ id: "discord-user-id" });
  mocks.getGuildMember.mockResolvedValue(null);
  mocks.addGuildMember.mockResolvedValue({});
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen.

async function send(path: string, cookie?: string) {
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = admin;
    return next();
  });
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      setCookies: res.headers.getSetCookie(),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function clearsState(setCookies: string[]) {
  return setCookies.some(
    (c) =>
      c.startsWith("oauth2_state=;") && c.includes("expires=Thu, 01 Jan 1970"),
  );
}

////////////////////////////////////////////////////////////

describe("GET /discord/callback", () => {
  // Intent: a callback with no state redeems nothing.
  // Why it exists: the state check compared two missing values and passed, so
  // a forged callback added the attacker's Discord account under the victim's
  // name with roles from the victim's forum role.
  // Scenario: an attacker starts /discord, keeps the unredeemed code, and sends
  // a logged-in admin who never started the flow /discord/callback?code=<code>.
  it("rejects a callback with no state before redeeming its code", async () => {
    const res = await send("/discord/callback?code=attacker-code");

    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.addGuildMember).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(clearsState(res.setCookies)).toBe(true);
  });

  it("joins a user whose callback carries the state their browser was issued", async () => {
    const start = await send("/discord");
    const { state } = mocks.authorizeURL.mock.calls[0]![0];
    const issued = start.setCookies.find((c) =>
      c.startsWith(`oauth2_state=${state};`),
    )!;
    // The return from discord.com is a cross-site top-level GET, which would
    // drop a strict cookie.
    expect(issued).toContain("; samesite=lax");
    expect(issued).toContain("; httponly");
    // A leaked state stays live for minutes, not for the browser session.
    const expires = Date.parse(/; expires=([^;]+)/.exec(issued)![1]!);
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires).toBeLessThan(Date.now() + 60 * 60 * 1000);

    const res = await send(
      `/discord/callback?state=${state}&code=good-code`,
      `oauth2_state=${state}`,
    );

    expect(mocks.getToken).toHaveBeenCalledWith({
      code: "good-code",
      redirect_uri: "https://guild.example/discord/callback",
    });
    expect(mocks.addGuildMember).toHaveBeenCalledWith(
      "guild-id",
      "discord-user-id",
      {
        access_token: "access-token",
        nick: admin.uname,
        roles: ["admin-role-id", "staff-role-id"],
      },
    );
    expect(res.status).toBe(302);
    expect(res.location).toBe("https://discord.com/channels/guild-id");
    expect(clearsState(res.setCookies)).toBe(true);
  });

  // Intent: a failed redeem still ends the state.
  // Why it exists: Koa's error handler removes every response header, so a
  // thrown error would drop the clear and leave the state live for a retry.
  // Scenario: an attacker who holds a leaked live state sends the victim a
  // callback link with a bad code. Discord rejects the code, and the attacker
  // must not get a second try with a good one.
  it("clears the state when the code fails to redeem", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errorSpy.mockRestore());
    mocks.getToken.mockRejectedValue(new Error("invalid_grant"));

    const res = await send(
      "/discord/callback?state=live-state&code=bad-code",
      "oauth2_state=live-state",
    );

    expect(res.status).toBe(500);
    expect(clearsState(res.setCookies)).toBe(true);
    expect(mocks.addGuildMember).not.toHaveBeenCalled();
  });
});
