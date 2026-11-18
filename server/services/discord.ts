// The forum's messages to Discord channels. Staff alerts (nukes, spam reviews,
// a failing classifier) send one message per event. A note about a member's
// own action is a member relay, and goes only through relayOnce, so each
// member relays each kind once, under a per-kind hourly ceiling. See
// docs/agents/discord.md#member-relays.
// 3rd
import assert from "assert";
// 1st
import Client, { type CreateMessageAllowedMentions } from "../discord/client";
import { fitContent } from "../discord/content";
import * as config from "../config";
import { claimRelay } from "../db/member_relays";
import * as pre from "../presenters";
import * as belt from "../belt";
import type { DbUser } from "../dbtypes";

//
// TODO: DRY up these functions.
// TODO: Avoid the #staff-channel lookup on every function call.
//

////////////////////////////////////////////////////////////

function makeClient(): Client | null {
  if (!config.DISCORD_BOT_TOKEN) {
    return null;
  }
  return new Client({ botToken: config.DISCORD_BOT_TOKEN });
}

type BroadcastOpts = {
  allowedMentions?: CreateMessageAllowedMentions;
  // Data shown under the head as JSON in a sealed code block, and cut first
  // when the message runs long. See docs/agents/discord.md#messages.
  detail?: unknown;
};

const EVERYONE_ALLOWED_MENTIONS = {
  parse: ["everyone"],
} satisfies CreateMessageAllowedMentions;

// The only caller of client.createMessage. fitContent turns the head and the
// detail into content Discord accepts.
async function postToChannel(
  channelName: string,
  head: string,
  opts: BroadcastOpts = {},
): Promise<void> {
  if (!config.DISCORD_BOT_TOKEN || !config.DISCORD_GUILD_ID) {
    console.warn(
      `[discord] bot token / guild id not set; skipping #${channelName}`,
    );
    return;
  }

  const client = makeClient();
  if (!client) {
    return;
  }

  const channel = await client
    .listGuildChannels(config.DISCORD_GUILD_ID)
    .then((cs) => cs.find((c) => c.name === channelName));

  if (!channel) {
    console.warn(`[discord] no #${channelName} channel found`);
    return;
  }

  await client.createMessage(channel.id, {
    content: fitContent(head, opts.detail),
    allowed_mentions: opts.allowedMentions ?? { parse: [] },
  });
}

////////////////////////////////////////////////////////////

// nuker and spambot are users
export const broadcastManualNuke = async ({ nuker, spambot }) => {
  assert(nuker);
  assert(spambot);
  pre.presentUser(nuker);
  pre.presentUser(spambot);

  const content = `:hammer: **${nuker.uname}** nuked ${config.HOST}${
    spambot.url
  } :radioactive:`;

  console.log(content);

  await postToChannel("forum-activity", content);
};

////////////////////////////////////////////////////////////

// nuker and spambot are users
export const broadcastManualUnnuke = async ({ nuker, spambot }) => {
  assert(nuker);
  assert(spambot);
  pre.presentUser(nuker);
  pre.presentUser(spambot);

  const content = `:white_check_mark: **${nuker.uname}** UN-nuked ${
    config.HOST
  }${spambot.url}`;

  await postToChannel("forum-activity", content);
};

////////////////////////////////////////////////////////////

// Info is an object of arbitrary data about the analysis
// to be sent along with the broadcast for debugging purposes.
export const broadcastAutoNuke = async (user, postId, info) => {
  assert(user);
  assert(Number.isInteger(postId));

  // Need url
  pre.presentUser(user);

  const head = `@here :robot: User ${config.HOST}${
    user.url
  } was auto-nuked for this post: ${config.HOST}/posts/${
    postId
  }/raw :radioactive:`;

  await postToChannel("forum-activity", head, {
    allowedMentions: EVERYONE_ALLOWED_MENTIONS,
    detail: info,
  });
};

////////////////////////////////////////////////////////////

// When a post is flagged as mid-confidence (possible) spam: post a lightweight
// "please review" note (no @here, no nuke). verdict is the SpamVerdict object,
// sent along for the reviewer's context.
export const broadcastSpamReview = async (user, postId, verdict) => {
  assert(user);
  assert(Number.isInteger(postId));

  // Need url
  pre.presentUser(user);

  const head = `:mag: Possible spam (conf ${verdict.confidence}) by ${
    config.HOST
  }${user.url} -- please review ${config.HOST}/posts/${postId}/raw`;

  await postToChannel("forum-activity", head, { detail: verdict });
};

////////////////////////////////////////////////////////////

// When the spam classifier's probe gets no verdict. Until it answers again,
// every post it should screen is allowed unchecked.
export async function broadcastClassifierFailing(
  error: "API_TIMEOUT" | "API_ERROR",
) {
  await postToChannel(
    "forum-activity",
    `:rotating_light: spam classifier is failing open: ${error}`,
  );
}

////////////////////////////////////////////////////////////
// Member relays

// The member a relay is about, and a recipient a first convo names
export type RelayMember = { id: number; uname: string; slug: string };

// What each kind of member relay carries. The keys are the closed set of
// kinds, so a new member relay is a new key here, with its message in RELAYS.
type RelayPayloads = {
  // A topic in forum 2, Introduce Yourself, that the spam check did not flag
  intro: { topicUrl: string };
  // A post by a member with no posts, once the spam check allowed it
  first_post: {
    postId: number;
    antispam:
      | { ran: true }
      | { ran: false; error: "API_TIMEOUT" | "API_ERROR" };
    markup: string;
  };
  // A member with no posts started their first convo
  first_convo: { recipients: RelayMember[] };
  // A new member (server/trust.ts) set a bio where they had none
  bio: { bioMarkup: string };
};

export type RelayKind = keyof RelayPayloads;

type Relay<K extends RelayKind> = {
  channel: string;
  // Names the events in the note that says the kind's relays are held
  label: string;
  head: (member: RelayMember, payload: RelayPayloads[K]) => string;
};

// The full URL of a member's profile page
function profileUrl(member: RelayMember): string {
  return config.HOST + pre.presentUser({ ...member } as DbUser)!.url;
}

const RELAYS: { [K in RelayKind]: Relay<K> } = {
  intro: {
    channel: "general",
    label: "Introduce Yourself topics",
    head: (member, { topicUrl }) =>
      `Howdy, :wave: **${member.uname}** created an Introduce Yourself thread: ` +
      `${config.HOST}${topicUrl}. Please help us welcome them!`,
  },
  first_post: {
    channel: "forum-activity",
    label: "first posts",
    head: (member, { postId, antispam, markup }) => {
      const snippet = belt.truncate(
        (markup || "").replace(/\s+/g, " ").trim(),
        280,
      );
      const status = antispam.ran
        ? ":white_check_mark: passed spam check"
        : `:warning: spam check did NOT run (${antispam.error}) -- manual review recommended`;
      return (
        `:memo: First post by ${profileUrl(member)} -- ${status}\n` +
        `> ${snippet}\n${config.HOST}/posts/${postId}`
      );
    },
  },
  first_convo: {
    channel: "forum-activity",
    label: "first convos",
    head: (member, { recipients }) => {
      const to = recipients
        .map((recipient) => `**${recipient.uname}** (${profileUrl(recipient)})`)
        .join(", ");
      return (
        `:love_letter: New user ${profileUrl(member)} started their first ` +
        `conversation with ${to}`
      );
    },
  },
  bio: {
    channel: "forum-activity",
    label: "newly set bios",
    head: (member, { bioMarkup }) =>
      `:eye: ${profileUrl(member)} just set their bio. Is it spam?\n` +
      `Snippet: \`${bioMarkup.slice(0, 140)}\`\n`,
  },
};

/**
 * The only way a note about a member's own action reaches Discord. The caller
 * decides that the event happened; claimRelay decides whether it posts: once
 * per member and kind, and only while the kind is under its hourly ceiling.
 * Past the ceiling the relay is logged, and staff get one note per cooldown
 * that the kind is held.
 */
export async function relayOnce<K extends RelayKind>(
  kind: K,
  member: RelayMember,
  payload: RelayPayloads[K],
): Promise<void> {
  const relay: Relay<K> = RELAYS[kind];
  const decision = await claimRelay(kind, member.id);
  switch (decision) {
    case "repeat":
      return;
    case "post":
      await postToChannel(relay.channel, relay.head(member, payload));
      return;
    case "hold":
    case "hold-and-note": {
      const ceiling = config.MEMBER_RELAY_CEILING_PER_HOUR;
      console.warn(
        `[discord] held the ${kind} relay for user ${member.id}: over ${ceiling} in the past hour`,
      );
      if (decision === "hold-and-note") {
        await postToChannel(
          "forum-activity",
          `:pause_button: Over ${ceiling} ${relay.label} in the past hour. ` +
            `Their relays are held until the count drops; check new members by hand.`,
        );
      }
      return;
    }
    default: {
      const exhaustive: never = decision;
      throw exhaustive;
    }
  }
}
