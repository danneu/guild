// 3rd
import assert from "assert";
// 1st
import Client, { type CreateMessageAllowedMentions } from "../discord/client";
import * as config from "../config";
import * as pre from "../presenters";
import * as belt from "../belt";

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
};

const EVERYONE_ALLOWED_MENTIONS = {
  parse: ["everyone"],
} satisfies CreateMessageAllowedMentions;

async function postToChannel(
  channelName: string,
  content: string,
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
    content,
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

// When a user is auto-nuked because of their IP address
export const broadcastIpAddressAutoNuke = async (user, ipAddress) => {
  assert(user);
  assert(typeof ipAddress === "string");

  // Need url
  pre.presentUser(user);

  const content = `@here :spy: User ${config.HOST}${
    user.url
  } was auto-nuked (vpn/proxy/bad: https://ipinfo.io/${
    ipAddress
  }) :radioactive:`;

  await postToChannel("forum-activity", content, {
    allowedMentions: EVERYONE_ALLOWED_MENTIONS,
  });
};

////////////////////////////////////////////////////////////

// Info is an object of arbitrary data about the analysis
// to be sent along with the broadcast for debugging purposes.
export const broadcastAutoNuke = async (user, postId, info) => {
  assert(user);
  assert(Number.isInteger(postId));

  // Need url
  pre.presentUser(user);

  const content = `@here :robot: User ${config.HOST}${
    user.url
  } was auto-nuked for this post: ${config.HOST}/posts/${
    postId
  }/raw :radioactive:

\`\`\`
${JSON.stringify(info, null, 2)}
\`\`\`
  `.trim();

  await postToChannel("forum-activity", content, {
    allowedMentions: EVERYONE_ALLOWED_MENTIONS,
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

  const content = `:mag: Possible spam (conf ${verdict.confidence}) by ${
    config.HOST
  }${user.url} -- please review ${config.HOST}/posts/${postId}/raw

\`\`\`
${JSON.stringify(verdict, null, 2)}
\`\`\`
  `.trim();

  await postToChannel("forum-activity", content);
};

////////////////////////////////////////////////////////////

export const broadcastUserJoin = async (user) => {
  // Need url
  pre.presentUser(user);

  await postToChannel(
    "forum-activity",
    `@here :baby: A new user joined: ${config.HOST}${user.url}`,
  );
};

////////////////////////////////////////////////////////////

export async function broadcastFirstPost(
  user,
  postId: number,
  antispam: { ran: true } | { ran: false; error: "API_TIMEOUT" | "API_ERROR" },
  markup: string,
) {
  pre.presentUser(user);

  const snippet = belt.truncate(
    (markup || "").replace(/\s+/g, " ").trim(),
    280,
  );
  const status = antispam.ran
    ? ":white_check_mark: passed spam check"
    : `:warning: spam check did NOT run (${antispam.error}) -- manual review recommended`;
  const content =
    `:memo: First post by ${config.HOST}${user.url} -- ${status}\n` +
    `> ${snippet}\n${config.HOST}/posts/${postId}`;

  await postToChannel("forum-activity", content);
}

////////////////////////////////////////////////////////////

export async function broadcastFirstConvo(sender, recipients) {
  pre.presentUser(sender);
  recipients.forEach((recipient) => pre.presentUser(recipient));

  const to = recipients
    .map(
      (recipient) => `**${recipient.uname}** (${config.HOST}${recipient.url})`,
    )
    .join(", ");
  const content =
    `:love_letter: New user ${config.HOST}${sender.url} started their first ` +
    `conversation with ${to}`;

  await postToChannel("forum-activity", content);
}

////////////////////////////////////////////////////////////

export const broadcastIntroTopic = async (user, topic) => {
  // Need url
  pre.presentUser(user);
  pre.presentTopic(topic);

  const content = `Howdy, :wave: **${
    user.uname
  }** created an Introduce Yourself thread: ${config.HOST}${
    topic.url
  }. Please help us welcome them!`;

  await postToChannel("general", content);
};

////////////////////////////////////////////////////////////

export async function broadcastBioUpdate(user, bioMarkup) {
  assert(user);
  assert(typeof bioMarkup === "string");

  pre.presentUser(user);

  const content = `:eye: ${config.HOST}${user.url} just set their bio. Is it spam?
Snippet: \`${bioMarkup.slice(0, 140)}\`
`;

  await postToChannel("forum-activity", content);
}
