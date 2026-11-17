// The Discord bot. It runs inside the web process, on whichever machine holds
// the Postgres advisory lock BOT_LOCK, so at most one machine answers at once.
// A failure of the lock connection, the login, or the bot restarts the bot
// after a backoff. None may reach Node as an unhandled rejection or an unheard
// 'error' event: either one exits the web process (hunt 261117-0852-024).

// 3rd
import {
  Client as DiscordClient,
  GatewayIntentBits,
  type Message,
} from "discord.js";
// 1st
import * as config from "./config";
import * as dice from "./dice";
import { getClient } from "./db/util";

// One-key advisory lock held by the machine that runs the bot.
const BOT_LOCK = 1337;

// The wait between attempts doubles from FIRST_RETRY_MS up to MAX_RETRY_MS. An
// attempt that lasted RESET_AFTER_MS starts it over.
export const FIRST_RETRY_MS = 1000 * 10;
const MAX_RETRY_MS = 1000 * 60 * 10;
const RESET_AFTER_MS = 1000 * 60 * 60;

// The wait before the next attempt, from the wait before the last one (null
// if there was none) and how long the last attempt lasted.
export function nextRetryMs(lastRetryMs: number | null, lastedMs: number) {
  if (lastRetryMs === null || lastedMs >= RESET_AFTER_MS) {
    return FIRST_RETRY_MS;
  }
  return Math.min(lastRetryMs * 2, MAX_RETRY_MS);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Starts the bot in the background if Discord is configured. It returns
// nothing to await: the bot restarts on its own after each failure.
function start(): void {
  if (!config.IS_DISCORD_CONFIGURED) {
    console.log("Cannot start GuildBot because Discord is not configured");
    return;
  }
  supervise().catch((err) => console.error("guildbot supervisor died", err));
}

async function supervise(): Promise<never> {
  let retryMs: number | null = null;
  for (;;) {
    const startedAt = Date.now();
    const err = await runAttempt();
    retryMs = nextRetryMs(retryMs, Date.now() - startedAt);
    console.error(`guildbot stopped, restarting in ${retryMs}ms:`, err);
    await sleep(retryMs);
  }
}

// Runs the bot until something fails, then stops it and returns the failure.
// Every failure rejects `failure`: a step that rejects, or an 'error' from the
// lock client or the bot. Each step races it, so the attempt ends at the first
// failure, and cleanup runs once however many arrive.
async function runAttempt(): Promise<unknown> {
  let fail!: (err: unknown) => void;
  const failure = new Promise<never>((_, reject) => (fail = reject));
  const pgClient = getClient(fail);
  let bot: DiscordClient | null = null;
  try {
    await Promise.race([pgClient.connect(), failure]);
    // Waits inside Postgres until the holder's session ends.
    await Promise.race([
      pgClient.query("SELECT pg_advisory_lock($1)", [BOT_LOCK]),
      failure,
    ]);
    bot = createBot(fail);
    await Promise.race([bot.login(config.DISCORD_BOT_TOKEN), failure]);
    return await failure;
  } catch (err) {
    return err;
  } finally {
    if (bot) {
      await bot
        .destroy()
        .catch((err) => console.error("guildbot destroy failed", err));
    }
    // Ending the session releases the lock.
    await pgClient
      .end()
      .catch((err) => console.error("guildbot lock client end failed", err));
  }
}

function createBot(fail: (err: unknown) => void): DiscordClient {
  const bot = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
  });

  // discord.js turns a rejecting listener into an 'error' (captureRejections).
  bot.on("error", fail);

  bot.on("ready", () => {
    console.log(`Logged in as ${bot.user?.username}!`);
  });

  bot.on("messageCreate", (msg) => {
    handleMessage(msg).catch((err) =>
      console.error("guildbot could not answer a message", err),
    );
  });

  return bot;
}

async function handleMessage(msg: Message): Promise<void> {
  console.log("GuildBot sees message:", msg.content);
  if (msg.content === "!ping") {
    await reply(msg, "pong");
    return;
  }

  if (msg.content.startsWith("!roll ")) {
    const [_, syntax] = msg.content.split(/\s+/);
    if (syntax!.length === 0) return;

    let output;
    try {
      output = dice.roll(syntax);
    } catch (err) {
      await reply(msg, `Error: ${err}`);
      return;
    }

    const rollValues = [].concat.apply(
      [],
      output.rolls.map((r) => r.values),
    );

    if (rollValues.length > 1 && rollValues.length <= 10) {
      await reply(
        msg,
        `:game_die: ${syntax} → ${JSON.stringify(
          rollValues,
        )} → \`${output.total}\``,
      );
    } else {
      await reply(msg, `:game_die: ${syntax} → \`${output.total}\``);
    }
  }
}

// The one way the bot answers a message.
async function reply(msg: Message, text: string): Promise<void> {
  await msg.reply(text);
}

export default { start };
