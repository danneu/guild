// The only code that writes a Discord guild member: adding one, and any change
// to a member's roles or nick. The bot's per-member endpoints are private
// functions here, over server/discord/client.ts#Client.botRequest.
// server/discord/join.test.ts fails on a per-member path, or on a discord.js
// member write, anywhere else in server/. Channel messages are not member
// writes, and stay out of this file.
//
// The join runs on GET /discord/callback. Both write gates pass every GET as a
// read, so joinDiscord asks their predicates itself.
//
// The bot needs these permissions in the Discord server: CHANGE_NICKNAME,
// MANAGE_NICKNAMES, MANAGE_ROLES and CREATE_INSTANT_INVITE.

import assert from "assert";
import type {
  APIGuildMember,
  APIRole,
  RESTPutAPIGuildMemberJSONBody,
} from "discord-api-types/v10";
// 1st
import * as config from "../config";
import { claimDiscordLink } from "../db/discord_links";
import type { DbUser } from "../dbtypes";
import { isEmailGateSatisfied } from "../middleware/require-confirmed-email";
import { isBanned } from "../middleware/require-not-banned";
import Client, { ResponseNotOkError } from "./client";

export type Joiner = Pick<
  DbUser,
  "id" | "uname" | "role" | "email_verified_at" | "email_gate_exempt_at"
>;

// Why a join was refused. Nothing is written for a refused join.
export type JoinRefusal = "BANNED" | "EMAIL_UNCONFIRMED" | "LINKED_ELSEWHERE";

export type JoinResult = { ok: true } | { ok: false; refusal: JoinRefusal };

/**
 * Whether the write gates refuse this account a join, from their own
 * predicates. GET /discord asks it too, so a refused user is not sent through
 * Discord's consent page first.
 */
export function joinRefusal(
  user: Joiner,
): Exclude<JoinRefusal, "LINKED_ELSEWHERE"> | null {
  if (isBanned(user)) return "BANNED";
  if (!isEmailGateSatisfied(user)) return "EMAIL_UNCONFIRMED";
  return null;
}

/**
 * Adds the Discord account behind an OAuth grant to the Discord server, with
 * the forum uname as its nick and roles from the forum role.
 *
 * It refuses a banned or unconfirmed account before any Discord call, so it
 * takes the token as `redeemToken` and redeems the grant only after the
 * gates pass. Before it adds anyone, it claims the account's link
 * (server/db/discord_links.ts#claimDiscordLink) and refuses a Discord id
 * other than the one the link holds. A Discord account already in the server
 * is left as it is: nothing is written and nothing is claimed.
 *
 * Concurrent callbacks are safe. The claim lets one Discord id through, and
 * Discord answers a repeat add of the same user with 204.
 */
export async function joinDiscord(
  discord: Client,
  user: Joiner,
  redeemToken: () => Promise<string>,
): Promise<JoinResult> {
  assert(user, "joinDiscord needs a forum account");
  const refusal = joinRefusal(user);
  if (refusal) return { ok: false, refusal };

  const guildId = config.DISCORD_GUILD_ID;
  assert(guildId, "DISCORD_GUILD_ID is not set");

  const accessToken = await redeemToken();
  const discordUser = await discord.getUser(accessToken);

  // Not renamed: it might be a mod's own account, logged in to a member alt.
  if (await getGuildMember(discord, guildId, discordUser.id)) {
    return { ok: true };
  }

  const linked = await claimDiscordLink(user.id, discordUser.id);
  if (linked !== discordUser.id) {
    return { ok: false, refusal: "LINKED_ELSEWHERE" };
  }

  await addGuildMember(discord, guildId, discordUser.id, {
    access_token: accessToken,
    nick: user.uname,
    roles: rolesFor(user.role, await discord.listRoles(guildId)),
  });
  return { ok: true };
}

// The Discord roles a forum role gets, matched by name in the Discord server.
function rolesFor(forumRole: string, discordRoles: APIRole[]): string[] {
  const idByName = new Map(discordRoles.map((role) => [role.name, role.id]));
  let names: string[] = [];
  if (["smod", "admin"].includes(forumRole)) {
    names = ["Admin", "Staff"];
  } else if (["conmod", "arenamod", "mod"].includes(forumRole)) {
    names = ["Staff"];
  } else if (forumRole === "member") {
    names = ["Member"];
  }
  return names.flatMap((name) => idByName.get(name) ?? []);
}

async function getGuildMember(
  discord: Client,
  guildId: string,
  userId: string,
): Promise<APIGuildMember | null> {
  const url = `/guilds/${guildId}/members/${userId}`;
  return discord.botRequest<APIGuildMember>("GET", url).catch((err) => {
    if (err instanceof ResponseNotOkError && err.status === 404) {
      return null;
    }
    throw err;
  });
}

async function addGuildMember(
  discord: Client,
  guildId: string,
  userId: string,
  body: RESTPutAPIGuildMemberJSONBody,
): Promise<void> {
  const url = `/guilds/${guildId}/members/${userId}`;
  await discord.botRequest<APIGuildMember>("PUT", url, body);
}
