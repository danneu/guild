import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// Intent: a Discord reply or a bot login that fails never reaches Node as an
// unhandled rejection, and any failure of the bot or its lock connection
// restarts the bot instead of the process.
// Why it exists: the bot runs inside the web process, and Node exits on an
// unhandled rejection. A member who sent '!ping' and deleted it before the
// reply landed, or a revoked token at boot, took down every request on the
// machine that held the bot lock (hunt 261117-0852-024).
// Scenario: the bot takes the lock and logs in; a '!ping' reply rejects. Then
// a bot whose login rejects, and bots whose lock client or gateway fails.
//
// The fakes below return promises from plain functions, never from vi.fn: a
// vitest spy attaches handlers to every promise it returns, which would hide
// the very rejection these tests look for.

type Emitter = import("node:events").EventEmitter;

const fake = vi.hoisted(() => ({
  login: (): Promise<string> => Promise.resolve("token"),
  lock: (): Promise<unknown> => Promise.resolve({ rows: [{}] }),
  bots: [] as Array<Emitter & { destroyed: number }>,
  clients: [] as Array<Emitter & { ended: number }>,
}));

vi.mock("discord.js", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    user = { username: "guildbot" };
    destroyed = 0;
    constructor() {
      super();
      fake.bots.push(this);
    }
    login() {
      return fake.login();
    }
    destroy() {
      this.destroyed++;
      return Promise.resolve();
    }
  }
  return {
    Client,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      GuildMembers: 8,
    },
  };
});

vi.mock("./db/util", async () => {
  const { EventEmitter } = await import("node:events");
  class PgClient extends EventEmitter {
    ended = 0;
    connect() {
      return Promise.resolve();
    }
    query() {
      return fake.lock();
    }
    end() {
      this.ended++;
      return Promise.resolve();
    }
  }
  return {
    getClient(onError: (err: Error) => void) {
      const client = new PgClient();
      client.on("error", onError);
      fake.clients.push(client);
      return client;
    },
  };
});

vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  IS_DISCORD_CONFIGURED: true,
  DISCORD_BOT_TOKEN: "token",
}));

import guildbot, { FIRST_RETRY_MS, nextRetryMs } from "./guildbot";

// One real macrotask turn: every promise the bot chained on the fakes has
// settled, and Node has reported any rejection left unhandled.
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function startBot() {
  guildbot.start();
  await settle();
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

// A '!ping' message whose reply rejects, as discord.js does when the member
// deleted the message first.
function deletedPing() {
  const replies: string[] = [];
  return {
    replies,
    content: "!ping",
    reply(text: string) {
      replies.push(text);
      return Promise.reject(new Error("Unknown message"));
    },
  };
}

function dead() {
  return new Error("Connection terminated unexpectedly");
}

let unhandled: Mock;

beforeEach(() => {
  fake.bots.length = 0;
  fake.clients.length = 0;
  fake.login = () => Promise.resolve("token");
  fake.lock = () => Promise.resolve({ rows: [{}] });
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
});

afterEach(() => {
  process.off("unhandledRejection", unhandled);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("guildbot", () => {
  it("survives a '!ping' whose reply fails", async () => {
    await startBot();
    const msg = deletedPing();

    fake.bots[0]!.emit("messageCreate", msg);
    await settle();

    expect(msg.replies).toEqual(["pong"]);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("survives a login that fails", async () => {
    fake.login = () =>
      Promise.reject(new Error("An invalid token was provided."));

    await startBot();

    expect(fake.bots).toHaveLength(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(fake.bots[0]!.destroyed).toBe(1);
    expect(fake.clients[0]!.ended).toBe(1);
  });

  it("builds no bot until it holds the lock", async () => {
    fake.lock = () => new Promise(() => {});

    await startBot();

    expect(fake.clients).toHaveLength(1);
    expect(fake.bots).toHaveLength(0);
  });

  it.each([
    ["lock client", () => fake.clients[0]!],
    ["bot", () => fake.bots[0]!],
  ])("restarts the bot after an error from its %s", async (_, source) => {
    await startBot();

    source().emit("error", dead());
    await settle();

    expect(fake.bots[0]!.destroyed).toBe(1);
    expect(fake.clients[0]!.ended).toBe(1);
    await advance(FIRST_RETRY_MS - 1);
    expect(fake.clients).toHaveLength(1);
    await advance(1);
    expect(fake.clients).toHaveLength(2);
    expect(fake.bots).toHaveLength(2);
  });

  it("cleans up once and retries once when two failures arrive together", async () => {
    fake.login = () => {
      fake.login = () => Promise.resolve("token");
      const rejected = Promise.reject(new Error("Discord is down"));
      fake.clients[0]!.emit("error", dead());
      return rejected;
    };

    await startBot();
    await advance(FIRST_RETRY_MS * 10);

    expect(fake.bots[0]!.destroyed).toBe(1);
    expect(fake.clients[0]!.ended).toBe(1);
    expect(fake.clients).toHaveLength(2);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("nextRetryMs", () => {
  it("doubles up to ten minutes, and starts over after an hour of running", () => {
    expect(nextRetryMs(null, 0)).toBe(FIRST_RETRY_MS);
    expect(nextRetryMs(FIRST_RETRY_MS, 0)).toBe(FIRST_RETRY_MS * 2);
    expect(nextRetryMs(1000 * 60 * 8, 0)).toBe(1000 * 60 * 10);
    expect(nextRetryMs(1000 * 60 * 10, 1000 * 60 * 59)).toBe(1000 * 60 * 10);
    expect(nextRetryMs(1000 * 60 * 10, 1000 * 60 * 60)).toBe(FIRST_RETRY_MS);
  });
});
