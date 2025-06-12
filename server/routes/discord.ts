// 3rd
import Router from "@koa/router";
import SimpleOauth2 from "simple-oauth2";
import { v7 as uuidv7 } from "uuid";
// 1st
import * as config from "../config";
import DiscordClient from "../discord/client";
import { Context, Next } from "koa";

////////////////////////////////////////////////////////////

function createRouter() {
  const router = new Router();

  router.use(async (ctx: Context, next: Next) => {
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

  const oauth2 = SimpleOauth2.create({
    client: {
      id: config.DISCORD_APP_CLIENTID,
      secret: config.DISCORD_APP_CLIENTSECRET,
    },
    auth: {
      tokenHost: "https://discord.com",
      tokenPath: "/api/oauth2/token",
      authorizePath: "/api/oauth2/authorize",
    },
  });

  const redirect_uri = `${config.HOST}/discord/callback`;

  const discord = new DiscordClient({ botToken: config.DISCORD_BOT_TOKEN });

  ////////////////////////////////////////////////////////////

  router.get("/discord", async (ctx: Context) => {
    const state = uuidv7();
    const authzUri = oauth2.authorizationCode.authorizeURL({
      redirect_uri,
      state,
      scope: ["identify", "guilds.join"].join(" "),
    });

    ctx.cookies.set("oauth2_state", state);
    ctx.redirect(authzUri);
  });

  ////////////////////////////////////////////////////////////

  router.get("/discord/channels/:channelName", async (ctx: Context) => {
    const channels = await discord.listChannels(config.DISCORD_GUILD_ID);
    const channel = channels.find((c) => {
      return c.name.toLowerCase() === ctx.params.channelName.toLowerCase();
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

    // tokenInfo looks like { access_token, expires_in, ...}
    const {
      token: { access_token: accessToken },
    } = await oauth2.authorizationCode
      .getToken({
        code,
        redirect_uri,
      })
      .then((result) => {
        return oauth2.accessToken.create(result);
      });

    ctx.cookies.set("oauth2_token", accessToken);

    // roleMap is a mapping of name -> id
    // { @everyone: _, Admin: _, Staff: _, Member: _ }
    const roleMap = await discord
      .listRoles(config.DISCORD_GUILD_ID)
      .then((roles) => {
        const mapping: Record<string, string> = {};
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

    const discordUser = await discord.getUser(accessToken);

    let guildMember = await discord.getGuildMember(
      config.DISCORD_GUILD_ID,
      discordUser.id,
    );

    if (guildMember) {
      // FIXME: modifyGuildMember is failing with 403 Forbidden (missing permissions)
      // However since they are already part of the server, I'll redirect them instead of failing.
      try {
        guildMember = await discord.modifyGuildMember(
          config.DISCORD_GUILD_ID,
          discordUser.id,
          {
            nick: ctx.currUser.uname,
          },
        );
      } catch (err) {
        if (err instanceof Error && "status" in err && err.status === 403) {
          // Missing permissions, but just go ahead instead of bailing
          console.log(
            "TODO: modifyGuildMember 403 Forbidden (missing permissions)",
          );
        } else {
          console.error("modifyGuildMember error", err);
          throw err;
        }
      }
    } else {
      guildMember = await discord.addGuildMember(
        config.DISCORD_GUILD_ID,
        discordUser.id,
        {
          access_token: accessToken,
          nick: ctx.currUser.uname,
          roles,
        },
      );
    }

    ctx.redirect(`https://discord.com/channels/${config.DISCORD_GUILD_ID}`);
  });

  ////////////////////////////////////////////////////////////

  return router;
}

export default createRouter()
