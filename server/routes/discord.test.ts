import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import router from "./discord";

// The router builds the OAuth client when the module loads, so the stub must
// be a constructor and must exist before the import above runs.
const mocks = vi.hoisted(() => {
  const authorizeURL = vi.fn();
  const getToken = vi.fn();
  return {
    authorizeURL,
    getToken,
    AuthorizationCode: vi.fn(function () {
      return { authorizeURL, getToken };
    }),
  };
});

vi.mock("simple-oauth2", () => ({
  AuthorizationCode: mocks.AuthorizationCode,
}));

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

// The discord_links rows, as forum user id -> Discord user id.
const links = vi.hoisted(() => new Map<number, string>());

// A fake pool for the link claim. It answers the way the table's primary key
// makes Postgres answer: the first Discord id claimed for an account stays.
// vitest cannot run Postgres here.
vi.mock("../db/util", async (importOriginal) => {
  const util = await importOriginal<typeof import("../db/util")>();
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (/INSERT INTO discord_links/.test(sql)) {
      const [userId, discordUserId] = params as [number, string];
      if (!links.has(userId)) links.set(userId, discordUserId);
      const rows = [{ discord_user_id: links.get(userId) }];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { ...util, pool: { query } };
});

////////////////////////////////////////////////////////////
// A fake Discord API behind fetch, so the test sees what reaches Discord
// whichever module makes the call. An OAuth code "<id>" redeems to the token
// "token-<id>", which belongs to the Discord user "<id>".

const realFetch = globalThis.fetch;

// Discord user ids in the server, and every member add Discord received
const discord = {
  members: new Set<string>(),
  adds: [] as { discordUserId: string; body: unknown }[],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeDiscord(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const route = `${method} ${url.pathname}`;
  const headers = new Headers(init.headers);
  const prefix = "/api/v10";

  if (route === `GET ${prefix}/guilds/guild-id/roles`) {
    return json(200, [
      { id: "admin-role-id", name: "Admin" },
      { id: "staff-role-id", name: "Staff" },
      { id: "member-role-id", name: "Member" },
    ]);
  }
  if (route === `GET ${prefix}/users/@me`) {
    const token = /^Bearer token-(.+)$/.exec(headers.get("authorization")!);
    return json(200, { id: token![1] });
  }
  const member = new RegExp(
    `^(GET|PUT) ${prefix}/guilds/guild-id/members/([^/]+)$`,
  ).exec(route);
  if (member?.[1] === "GET") {
    return discord.members.has(member[2]!)
      ? json(200, { user: { id: member[2] } })
      : json(404, { message: "Unknown Member", code: 10007 });
  }
  if (member?.[1] === "PUT") {
    discord.members.add(member[2]!);
    discord.adds.push({
      discordUserId: member[2]!,
      body: JSON.parse(String(init.body)),
    });
    return json(201, { user: { id: member[2] } });
  }
  throw new Error(`unexpected Discord call: ${route}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  links.clear();
  discord.members.clear();
  discord.adds.length = 0;
  vi.stubGlobal("fetch", vi.fn(fakeDiscord));
  mocks.authorizeURL.mockReturnValue("https://discord.com/oauth2/authorize");
  mocks.getToken.mockImplementation(async ({ code }: { code: string }) => ({
    token: { access_token: `token-${code}` },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen.

const admin = {
  id: 1,
  uname: "Admin",
  slug: "admin",
  role: "admin",
  email_verified_at: new Date(),
  email_gate_exempt_at: null,
};

const member = {
  id: 2,
  uname: "Member",
  slug: "member",
  role: "member",
  email_verified_at: new Date(),
  email_gate_exempt_at: null,
};

// Never confirmed an address and was never excused from the email gate
const unconfirmed = {
  id: 3,
  uname: "Newcomer",
  slug: "newcomer",
  role: "member",
  email_verified_at: null,
  email_gate_exempt_at: null,
};

async function send(
  path: string,
  { cookie, user = admin }: { cookie?: string; user?: object } = {},
) {
  const app = new Koa();
  app.silent = true;
  let flash: unknown;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = user;
    await next();
    flash = ctx.flash;
  });
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      setCookies: res.headers.getSetCookie(),
      flash,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A callback whose state matches the browser's, from the Discord account
// `discordUserId`
function callback(user: object, discordUserId: string) {
  return send(`/discord/callback?state=live-state&code=${discordUserId}`, {
    cookie: "oauth2_state=live-state",
    user,
  });
}

function clearsState(setCookies: string[]) {
  return setCookies.some(
    (c) =>
      c.startsWith("oauth2_state=;") && c.includes("expires=Thu, 01 Jan 1970"),
  );
}

////////////////////////////////////////////////////////////

describe("GET /discord", () => {
  it("sends an unconfirmed account to confirm its email before any Discord page", async () => {
    const res = await send("/discord", { user: unconfirmed });

    expect(mocks.authorizeURL).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.location).toBe("/confirm-email");
    expect(res.setCookies.some((c) => c.startsWith("oauth2_state="))).toBe(
      false,
    );
  });
});

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
    expect(discord.adds).toEqual([]);
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
      `/discord/callback?state=${state}&code=admin-discord`,
      { cookie: `oauth2_state=${state}` },
    );

    expect(mocks.getToken).toHaveBeenCalledWith({
      code: "admin-discord",
      redirect_uri: "https://guild.example/discord/callback",
    });
    expect(discord.adds).toEqual([
      {
        discordUserId: "admin-discord",
        body: {
          access_token: "token-admin-discord",
          nick: admin.uname,
          roles: ["admin-role-id", "staff-role-id"],
        },
      },
    ]);
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

    const res = await callback(admin, "bad-code");

    expect(res.status).toBe(500);
    expect(clearsState(res.setCookies)).toBe(true);
    expect(discord.adds).toEqual([]);
  });

  // Intent: an account that never confirmed an email is not added to the
  // Discord server.
  // Why it exists: the callback is a GET, and the email gate passes every GET
  // as a read, so an unconfirmed account joined with the Member role
  // (hunt 261117-0852-053).
  // Scenario: a spammer registers with an address they never confirm, then
  // finishes the Discord flow with a state their browser holds.
  it("never adds an account that has not confirmed an email", async () => {
    const res = await callback(unconfirmed, "spammer-discord");

    expect(discord.adds).toEqual([]);
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.location).toBe("/confirm-email");
    expect(clearsState(res.setCookies)).toBe(true);
  });

  // Intent: one forum account adds one Discord account to the server.
  // Why it exists: nothing recorded which Discord account a forum account
  // added, so one account repeated the flow and added any number of Discord
  // accounts as Member (hunt 261117-0852-053).
  // Scenario: a member joins with one Discord account, then finishes the flow
  // again from a second one.
  it("adds only the first Discord account a forum account brings", async () => {
    await callback(member, "first-discord");
    const res = await callback(member, "second-discord");

    expect(discord.adds.map((add) => add.discordUserId)).toEqual([
      "first-discord",
    ]);
    expect(res.status).toBe(302);
    expect(res.location).toBe("/");
    expect(res.flash).toEqual({
      message: ["warning", expect.stringMatching(/different Discord account/)],
    });
  });
});
