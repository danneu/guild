// 3rd
import Router, { RouterContext } from "@koa/router";
import {
  // ClientCredentials,
  // ResourceOwnerPassword,
  AuthorizationCode,
} from "simple-oauth2";
import { v7 as uuidv7 } from "uuid";

// 1st
import * as config from "../config";
import DiscordClient from "../discord/client";
import { Context, Next } from "koa";

////////////////////////////////////////////////////////////

// Ensure bot has these rolls on Discord dashboard:
// CHANGE_NICKNAME
// MANAGE_NICKNAMES
// MANAGE_ROLES
// CREATE_INSTANT_INVITE

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
      ctx.flash = {
        message: [
          "warning",
          "You cannot join the Discord server since you are banned.",
        ],
      };
      ctx.redirect("/");
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
    const state = uuidv7();

    // Use the new authorizeURL method
    const authzUri = client.authorizeURL({
      redirect_uri,
      state,
      scope: "identify guilds.join", // Note: scope is now a string, not an array
    });

    ctx.cookies.set("oauth2_state", state, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
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

  // FIXME: Race conditions
  router.get("/discord/callback", async (ctx: Context) => {
    if (!discord) {
      ctx.body = "Discord is not configured";
      return;
    }
    if (ctx.query.error) {
      ctx.body = `
      Error received from Discord API: ${ctx.query.error}
    `;
      return;
    }

    if (ctx.query.state !== ctx.cookies.get("oauth2_state")) {
      ctx.body = `
      Error: OAuth state mismatch
    `;
      return;
    }

    // Get code that Discord sent us via redirect params
    const { code } = ctx.query;
    ctx.assert(code, 400, "Expected code in OAuth redirect");

    try {
      // Use the new getToken method directly
      const accessToken = await client.getToken({
        code: code as string,
        redirect_uri,
      });

      // Access the token string directly
      const tokenString = accessToken.token.access_token as string;

      ctx.cookies.set("oauth2_token", tokenString);

      // roleMap is a mapping of name -> id
      // { @everyone: _, Admin: _, Staff: _, Member: _ }
      // roleMap [Object: null prototype] {
      //   '@everyone': '313921604868636672',
      //   Admin: '313921605744984064',
      //   Staff: '313921607754055680',
      //   Member: '313921608471412737',
      //   'Test RPGuild': '315210657228259330',
      //   Muted: '315214322898829313'
      // }
      const roleMap = await discord
        .listRoles(config.DISCORD_GUILD_ID!)
        .then((roles) => {
          const mapping: Record<string, string> = Object.create(null);
          roles.forEach((role) => {
            mapping[role.name] = role.id;
          });
          return mapping;
        });

      let roles: string[] = [];
      if (["smod", "admin"].includes(ctx.currUser.role)) {
        roles = [roleMap["Admin"] ?? "", roleMap["Staff"] ?? ""];
      } else if (["conmod", "arenamod", "mod"].includes(ctx.currUser.role)) {
        roles = [roleMap["Staff"] ?? ""];
      } else if (ctx.currUser.role === "member") {
        roles = [roleMap["Member"] ?? ""];
      }

      roles = roles.filter(Boolean);
      console.log("roleMap", roleMap);

      const discordUser = await discord.getUser(tokenString);

      let guildMember = await discord.getGuildMember(
        config.DISCORD_GUILD_ID!,
        discordUser.id,
      );

      if (guildMember) {
        // If there's already part of the server, just redirect them to the channel
        // We don't want to rename them because, say, they might be a mod logged in as a member alt
        //
        // Old code:
        //
        // FIXME: modifyGuildMember is failing with 403 Forbidden (missing permissions)
        // However since they are already part of the server, I'll redirect them instead of failing.
        // try {
        //   guildMember = await discord.modifyGuildMember(
        //     config.DISCORD_GUILD_ID!,
        //     discordUser.id,
        //     {
        //       nick: ctx.currUser.uname,
        //     },
        //   );
        // } catch (err) {
        //   if (err instanceof Error && "status" in err && err.status === 403) {
        //     // Missing permissions, but just go ahead instead of bailing
        //     console.log(
        //       "TODO: modifyGuildMember 403 Forbidden (missing permissions)",
        //     );
        //   } else {
        //     console.error("modifyGuildMember error", err);
        //     throw err;
        //   }
        // }
      } else {
        guildMember =
          (await discord.addGuildMember(
            config.DISCORD_GUILD_ID!,
            discordUser.id,
            {
              access_token: tokenString,
              nick: ctx.currUser.uname,
              roles,
            },
          )) ?? null;
      }

      ctx.redirect(`https://discord.com/channels/${config.DISCORD_GUILD_ID}`);
    } catch (error) {
      console.error("OAuth callback error:", error);
      ctx.throw(500, "Failed to complete OAuth flow");
    }
  });

  ////////////////////////////////////////////////////////////

  return router;
}

export default createRouter();
