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

// The member_relays claim, which runs SQL. A test sets its decision.
const claimRelay = vi.hoisted(() => vi.fn());
vi.mock("../db/member_relays", () => ({ claimRelay }));

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
    { id: "general-id", name: "general" },
    { id: "forum-activity-id", name: "forum-activity" },
  ]);
  claimRelay.mockReset();
  claimRelay.mockResolvedValue("post");

  return import("./discord");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// The content of the one message the broadcast sent.
function sentContent(): string {
  expect(clientMocks.createMessage).toHaveBeenCalledTimes(1);
  return clientMocks.createMessage.mock.calls[0]![1].content;
}

function verdict(reasoning: string) {
  return {
    reasoning,
    isSpam: true,
    confidence: 0.7,
    category: "other_promotional",
    injectionAttempt: false,
  };
}

describe("discord broadcasts", () => {
  // Intent: every export is a staff alert or relayOnce.
  // Why it exists: a member relay exported beside relayOnce would skip its
  // claim, so one account could flood a channel again, as each Introduce
  // Yourself topic flooded #general (hunt 261117-0852-012).
  // Scenario: list the module's exports.
  it("exports only staff alerts and relayOnce", async () => {
    const discord = await loadDiscord();

    expect(Object.keys(discord).sort()).toEqual([
      "broadcastAutoNuke",
      "broadcastClassifierFailing",
      "broadcastManualNuke",
      "broadcastManualUnnuke",
      "broadcastSpamReview",
      "relayOnce",
    ]);
  });

  it("suppresses mentions on member relays", async () => {
    const discord = await loadDiscord();

    await discord.relayOnce(
      "first_post",
      { id: 1, slug: "new-user", uname: "New User" },
      { postId: 123, antispam: { ran: true }, markup: "hello @everyone" },
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

  // Intent: a spam alert fits Discord's 2000-character cap whatever the
  // verdict holds, and keeps the link a reviewer needs.
  // Why it exists: the alert pasted the whole verdict, so a long reasoning
  // made Discord refuse it. For a REVIEW verdict the alert is the only action,
  // so the post stayed up unseen (hunt 261117-0852-026).
  // Scenario: a REVIEW verdict whose reasoning is 3000 characters.
  it("fits a spam review with a long reasoning under Discord's cap", async () => {
    const discord = await loadDiscord();

    await discord.broadcastSpamReview(
      { id: 3, slug: "maybe-spam", uname: "Maybe Spam" },
      125,
      verdict("x".repeat(3000)),
    );

    const content = sentContent();
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).toContain("https://guild.example/posts/125/raw");
  });

  // Intent: the verdict stays inside one code block, and a mention quoted in
  // it cannot ping.
  // Why it exists: Discord ends a code block at any ```, so a verdict quoting
  // one let the rest render as markdown, where an @everyone could use the
  // auto-nuke alert's mention grant (hunt 261117-0852-026).
  // Scenario: an auto-nuke verdict whose reasoning quotes ``` and @everyone.
  it("keeps a verdict holding ``` and @everyone inside one sealed block", async () => {
    const discord = await loadDiscord();

    await discord.broadcastAutoNuke(
      { id: 2, slug: "spambot", uname: "Spambot" },
      124,
      verdict("The post says ```\n@everyone buy now"),
    );

    const content = sentContent();
    expect(content.match(/```/g)).toHaveLength(2);
    expect(content.endsWith("```")).toBe(true);
    const block = content.slice(content.indexOf("```"));
    expect(block).toContain("buy now");
    expect(block).not.toMatch(/@(?!\u200B)/);
  });

  // Intent: a relay its kind's ceiling holds posts nothing, and staff hear
  // that the kind is held only when the claim says the note is due.
  // Why it exists: a flood of new accounts each relaying once would still
  // flood the channel, and a note on every held claim would flood
  // #forum-activity instead (hunt 261117-0852-012).
  // Scenario: two intros past the ceiling; the second claim says the note is
  // due.
  it("posts only the held note for relays over the ceiling", async () => {
    const discord = await loadDiscord();
    claimRelay
      .mockResolvedValueOnce("hold")
      .mockResolvedValueOnce("hold-and-note");

    for (const id of [4, 5]) {
      await discord.relayOnce(
        "intro",
        { id, slug: `new-${id}`, uname: `New ${id}` },
        { topicUrl: `/topics/${id}-hello` },
      );
    }

    expect(sentContent()).toContain(":pause_button:");
    expect(clientMocks.createMessage).toHaveBeenCalledWith(
      "forum-activity-id",
      expect.anything(),
    );
  });
});
