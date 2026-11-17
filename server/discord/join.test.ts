import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { claimDiscordLink } from "../db/discord_links";
import Client, { ResponseNotOkError } from "./client";
import { joinDiscord, type Joiner } from "./join";

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  DISCORD_GUILD_ID: "guild-id",
}));

// The discord_links rows, as forum user id -> Discord user id.
const links = vi.hoisted(() => new Map<number, string>());

// Answers the way the table's primary key makes Postgres answer: the first
// Discord id claimed for an account stays. vitest cannot run Postgres here;
// server/db/discord_links.test.ts covers the SQL.
vi.mock("../db/discord_links", () => ({
  claimDiscordLink: vi.fn(async (userId: number, discordUserId: string) => {
    if (!links.has(userId)) links.set(userId, discordUserId);
    return links.get(userId)!;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  links.clear();
});

////////////////////////////////////////////////////////////
// A fake Discord server behind the client. The token "token-<id>" belongs to
// the Discord user "<id>".

function makeDiscord({ members = [] as string[] } = {}) {
  const inServer = new Set(members);
  let failNextAdd = false;
  const botRequest = vi.fn(
    async (method: string, url: string, _body?: unknown) => {
      const member = /^\/guilds\/guild-id\/members\/([^/]+)$/.exec(url);
      if (member && method === "GET") {
        if (inServer.has(member[1]!)) return { user: { id: member[1] } };
        throw new ResponseNotOkError("404 Not Found", {
          status: 404,
          bodyText: '{"message": "Unknown Member", "code": 10007}',
        });
      }
      if (member && method === "PUT") {
        if (failNextAdd) {
          failNextAdd = false;
          throw new ResponseNotOkError("502 Bad Gateway", {
            status: 502,
            bodyText: "",
          });
        }
        inServer.add(member[1]!);
        return { user: { id: member[1] } };
      }
      throw new Error(`unexpected bot request: ${method} ${url}`);
    },
  );
  const fake = {
    botRequest,
    getUser: vi.fn(async (token: string) => ({
      id: token.replace(/^token-/, ""),
    })),
    listRoles: vi.fn(async () => [
      { id: "admin-role-id", name: "Admin" },
      { id: "staff-role-id", name: "Staff" },
      { id: "member-role-id", name: "Member" },
    ]),
  };
  return {
    fake,
    client: fake as unknown as Client,
    failNextAdd() {
      failNextAdd = true;
    },
    // [Discord user id, body] of every member add the bot sent
    adds(): [string, unknown][] {
      return botRequest.mock.calls
        .filter(([method]) => method === "PUT")
        .map(([, url, body]) => [url.split("/").pop()!, body]);
    },
  };
}

function join(
  discord: ReturnType<typeof makeDiscord>,
  user: Joiner,
  discordUserId: string,
) {
  const redeemToken = vi.fn(async () => `token-${discordUserId}`);
  return {
    redeemToken,
    result: joinDiscord(discord.client, user, redeemToken),
  };
}

const member: Joiner = {
  id: 2,
  uname: "Member",
  role: "member",
  email_verified_at: new Date(),
  email_gate_exempt_at: null,
};

// Never confirmed an address, but excused from the email gate
const exempt: Joiner = {
  ...member,
  id: 3,
  email_verified_at: null,
  email_gate_exempt_at: new Date(),
};

const unconfirmed: Joiner = {
  ...member,
  id: 4,
  email_verified_at: null,
  email_gate_exempt_at: null,
};

const banned: Joiner = { ...member, id: 5, role: "banned" };

////////////////////////////////////////////////////////////

describe("joinDiscord", () => {
  it.each([
    ["an unconfirmed account", unconfirmed, "EMAIL_UNCONFIRMED"],
    ["a banned account", banned, "BANNED"],
    [
      "a banned, unconfirmed account",
      { ...banned, email_verified_at: null },
      "BANNED",
    ],
  ])("refuses %s before any Discord call", async (_label, user, refusal) => {
    const discord = makeDiscord();

    const { redeemToken, result } = join(discord, user, "their-discord");

    await expect(result).resolves.toEqual({ ok: false, refusal });
    expect(redeemToken).not.toHaveBeenCalled();
    expect(discord.fake.getUser).not.toHaveBeenCalled();
    expect(discord.fake.listRoles).not.toHaveBeenCalled();
    expect(discord.fake.botRequest).not.toHaveBeenCalled();
    expect(claimDiscordLink).not.toHaveBeenCalled();
  });

  it.each([
    ["a confirmed member", member],
    ["a member excused from the email gate", exempt],
  ])(
    "adds %s with its uname and forum role, and links it",
    async (_label, user) => {
      const discord = makeDiscord();

      await expect(
        join(discord, user, "their-discord").result,
      ).resolves.toEqual({ ok: true });

      expect(discord.adds()).toEqual([
        [
          "their-discord",
          {
            access_token: "token-their-discord",
            nick: "Member",
            roles: ["member-role-id"],
          },
        ],
      ]);
      expect(links.get(user.id)).toBe("their-discord");
    },
  );

  it("leaves a Discord account already in the server as it is", async () => {
    const discord = makeDiscord({ members: ["old-hand"] });

    await expect(join(discord, member, "old-hand").result).resolves.toEqual({
      ok: true,
    });

    expect(discord.adds()).toEqual([]);
    expect(claimDiscordLink).not.toHaveBeenCalled();
  });

  it("refuses a Discord account other than the one the forum account linked", async () => {
    const discord = makeDiscord();
    links.set(member.id, "first-discord");

    await expect(
      join(discord, member, "second-discord").result,
    ).resolves.toEqual({ ok: false, refusal: "LINKED_ELSEWHERE" });

    expect(discord.adds()).toEqual([]);
    expect(links.get(member.id)).toBe("first-discord");
  });

  // Intent: two callbacks that race with different Discord accounts add one.
  // Why it exists: checking for a link and then writing one would let both
  // see no link and both add.
  // Scenario: a member finishes the flow in two tabs at once, from two Discord
  // accounts.
  it("lets one of two racing Discord accounts in", async () => {
    const discord = makeDiscord();

    const results = await Promise.all([
      join(discord, member, "tab-one").result,
      join(discord, member, "tab-two").result,
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        { ok: true },
        { ok: false, refusal: "LINKED_ELSEWHERE" },
      ]),
    );
    expect(discord.adds().map(([id]) => id)).toEqual([links.get(member.id)]);
  });

  it("lets the linked Discord account try again after a failed add", async () => {
    const discord = makeDiscord();
    discord.failNextAdd();

    await expect(join(discord, member, "their-discord").result).rejects.toThrow(
      ResponseNotOkError,
    );
    await expect(
      join(discord, member, "their-discord").result,
    ).resolves.toEqual({ ok: true });

    expect(discord.adds().map(([id]) => id)).toEqual([
      "their-discord",
      "their-discord",
    ]);
  });
});

////////////////////////////////////////////////////////////

// Intent: server/discord/join.ts is the only code that writes a guild member.
// Why it exists: the join skipped the email gate because nothing tied guild
// member writes to one place (hunt 261117-0852-053). A revived nick or role
// sync, a kick, or a second entry point elsewhere would skip it again.
// Scenario: a route calls botRequest("PATCH", `/guilds/${g}/members/${u}`) to
// sync a nick, or guildbot.ts calls member.roles.add(...).
describe("Discord guild member writes", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  function sourceFiles(): string[] {
    const dir = path.join(repoRoot, "server");
    return fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|js)$/.test(file) && !/\.test\.ts$/.test(file))
      .map((file) => path.join("server", file).split(path.sep).join("/"))
      .sort();
  }

  function filesMatching(pattern: RegExp): string[] {
    return sourceFiles().filter((file) =>
      pattern.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
    );
  }

  it("only server/discord/join.ts names a per-member REST endpoint", () => {
    expect(filesMatching(/\/guilds\/.*\/members\//)).toEqual([
      "server/discord/join.ts",
    ]);
  });

  it("no server code writes a member through discord.js", () => {
    expect(
      filesMatching(
        /\.roles\.(add|set|remove)\(|\.setNickname\(|\.members\.(add|edit|kick|ban|addRole|removeRole)\(/,
      ),
    ).toEqual([]);
  });
});
