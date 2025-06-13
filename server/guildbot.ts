// 3rd
import Discord from "discord.js";
// 1st
import * as config from "./config";
import * as dice from "./dice";
import { exactlyOneRow, getClient } from "./db/util";

function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  async connect() {
    if (!config.IS_DISCORD_CONFIGURED) {
      console.log("Cannot start GuildBot because Discord is not configured");
      return;
    }

    // Give previous guildbot a chance to shut down and release lock
    console.log("guildbot waiting a moment before connecting...");
    await timeout(1000 * 10);

    // Ensure only one bot is running

    const client = getClient();
    client.connect();

    const { lock } = await client
      .query<{ lock: boolean }>(`SELECT pg_try_advisory_lock(1337) "lock"`)
      .then(exactlyOneRow);

    if (!lock) {
      // Release the losing clients
      client.end();
      return;
    }

    const bot = new Discord.Client();

    bot.on("ready", () => {
      console.log(`Logged in as ${bot.user.username}!`);
    });

    bot.on("message", (msg) => {
      if (msg.content === "!ping") {
        msg.reply("pong");
        return;
      }

      if (msg.content.startsWith("!roll ")) {
        const [_, syntax] = msg.content.split(/\s+/);
        if (syntax!.length === 0) return;

        let output;
        try {
          output = dice.roll(syntax);
        } catch (err) {
          msg.reply(`Error: ${err}`);
          return;
        }

        const rollValues = [].concat.apply(
          [],
          output.rolls.map((r) => r.values),
        );

        if (rollValues.length > 1 && rollValues.length <= 10) {
          msg.reply(
            `:game_die: ${syntax} → ${JSON.stringify(
              rollValues,
            )} → \`${output.total}\``,
          );
        } else {
          msg.reply(`:game_die: ${syntax} → \`${output.total}\``);
        }
        return;
      }
    });

    bot.login(config.DISCORD_BOT_TOKEN);
  },
};
