import { afterEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => {
  const listGuildChannels = vi.fn();
  const createMessage = vi.fn();
  const Client = vi.fn(function () {
    return { listGuildChannels, createMessage };
  });

  return { Client, createMessage, listGuildChannels };
});

vi.mock("../discord/client", () => ({
  default: clientMocks.Client,
}));

async function loadDiscord() {
  vi.resetModules();
  vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
  vi.stubEnv("DISCORD_GUILD_ID", "guild-id");
  vi.stubEnv("HOST", "https://guild.example");

  clientMocks.Client.mockClear();
  clientMocks.createMessage.mockReset();
  clientMocks.listGuildChannels.mockReset();
  clientMocks.createMessage.mockResolvedValue({});
  clientMocks.listGuildChannels.mockResolvedValue([
    { id: "forum-activity-id", name: "forum-activity" },
  ]);

  return import("./discord");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("discord broadcasts", () => {
  it("suppresses mentions on first-action broadcasts", async () => {
    const discord = await loadDiscord();

    await discord.broadcastFirstPost(
      { id: 1, slug: "new-user", uname: "New User" },
      123,
      { ran: true },
      "hello @everyone",
    );

    expect(clientMocks.createMessage).toHaveBeenCalledWith(
      "forum-activity-id",
      expect.objectContaining({
        allowed_mentions: { parse: [] },
      }),
    );
  });

  it("allows everyone mentions on auto-nuke broadcasts", async () => {
    const discord = await loadDiscord();

    await discord.broadcastAutoNuke(
      { id: 2, slug: "spambot", uname: "Spambot" },
      124,
      { confidence: 0.95 },
    );

    expect(clientMocks.createMessage).toHaveBeenCalledWith(
      "forum-activity-id",
      expect.objectContaining({
        allowed_mentions: { parse: ["everyone"] },
      }),
    );
  });
});
