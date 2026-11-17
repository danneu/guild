// 3rd
import Router, { RouterContext } from "@koa/router";
import {
  // ClientCredentials,
  // ResourceOwnerPassword,
  AuthorizationCode,
} from "simple-oauth2";

// 1st
import * as config from "../config";
import DiscordClient from "../discord/client";
import { joinDiscord, joinRefusal, type JoinRefusal } from "../discord/join";
import { issueOAuthState, runOAuthCallback } from "../discord/oauth-state";
import type { FlashLevel } from "../middleware/flash";
import { Context, Next } from "koa";

////////////////////////////////////////////////////////////

// What a refused join tells the user, and where it sends them
const REFUSALS: Record<
  JoinRefusal,
  { level: FlashLevel; text: string; location: string }
> = {
  BANNED: {
    level: "warning",
    text: "You cannot join the Discord server since you are banned.",
    location: "/",
  },
  EMAIL_UNCONFIRMED: {
    level: "danger",
    text: "Please confirm your email address before you join the Discord server.",
    location: "/confirm-email",
  },
  LINKED_ELSEWHERE: {
    level: "warning",
    text: "Your Guild account already added a different Discord account to the server. Ask staff if you need to switch Discord accounts.",
    location: "/",
  },
};

// Sets the refusal's flash and returns where to send the user.
function refuse(ctx: Context, refusal: JoinRefusal): string {
  const { level, text, location } = REFUSALS[refusal];
  ctx.flash = { message: [level, text] };
  return location;
}

function createRouter() {
  const router = new Router();

  router.use(async (ctx: RouterContext, next: Next) => {
    // Ensure Discord is configured
    ctx.assert(config.IS_DISCORD_CONFIGURED, 404, "Discord is not configured");

    // Ensure user exists and is not banned
    if (!ctx.currUser) {
      ctx.flash = {
        message: [
          "warning",
          "You must be logged into the Guild to join the Discord chat server.",
        ],
      };
      ctx.redirect("/");
      return;
    }

    if (ctx.currUser.role === "banned") {
      const { level, text, location } = REFUSALS.BANNED;
      ctx.flash = { message: [level, text] };
      ctx.redirect(location);
      return;
    }

    return next();
  });

  ////////////////////////////////////////////////////////////

  if (!config.IS_DISCORD_CONFIGURED) {
    return router;
  }

  ////////////////////////////////////////////////////////////

  // Create OAuth2 client using the new syntax
  const oauth2Config = {
    client: {
      id: config.DISCORD_APP_CLIENTID!,
      secret: config.DISCORD_APP_CLIENTSECRET!,
    },
    auth: {
      tokenHost: "https://discord.com",
      tokenPath: "/api/oauth2/token",
      authorizePath: "/api/oauth2/authorize",
    },
  };

  const client = new AuthorizationCode(oauth2Config);

  const redirect_uri = `${config.HOST}/discord/callback`;

  const discord = config.DISCORD_BOT_TOKEN
    ? new DiscordClient({ botToken: config.DISCORD_BOT_TOKEN })
    : null;

  ////////////////////////////////////////////////////////////

  router.get("/discord", async (ctx: Context) => {
    // Only spares the user a trip through Discord: joinDiscord refuses them
    // anyway.
    const refusal = joinRefusal(ctx.currUser);
    if (refusal) {
      ctx.redirect(refuse(ctx, refusal));
      return;
    }

    // Use the new authorizeURL method
    const authzUri = client.authorizeURL({
      redirect_uri,
      state: issueOAuthState(ctx),
      scope: "identify guilds.join", // Note: scope is now a string, not an array
    });

    ctx.redirect(authzUri);
  });

  ////////////////////////////////////////////////////////////

  router.get("/discord/channels/:channelName", async (ctx: Context) => {
    if (!discord) {
      ctx.body = "Discord is not configured";
      return;
    }
    const channels = await discord.listGuildChannels(config.DISCORD_GUILD_ID!);
    const channel = channels.find((c) => {
      return c.name?.toLowerCase() === ctx.params.channelName.toLowerCase();
    });
    ctx.assert(channel, 404, "No Discord channel with that name was found");

    const url = `https://discord.com/channels/${config.DISCORD_GUILD_ID}/${
      channel.id
    }`;
    ctx.redirect(url);
  });

  ////////////////////////////////////////////////////////////

  router.get("/discord/callback", async (ctx: Context) => {
    if (!discord) {
      ctx.body = "Discord is not configured";
      return;
    }

    await runOAuthCallback(ctx, async (code) => {
      const result = await joinDiscord(discord, ctx.currUser, async () => {
        const accessToken = await client.getToken({ code, redirect_uri });
        return accessToken.token.access_token as string;
      });
      if (!result.ok) return refuse(ctx, result.refusal);
      return `https://discord.com/channels/${config.DISCORD_GUILD_ID}`;
    });
  });

  ////////////////////////////////////////////////////////////

  return router;
}

export default createRouter();
