// Builds the content of every message the forum sends to Discord, so Discord
// never refuses one for its length and a detail never breaks out of its code
// block. Broadcasts reach it through server/services/discord.ts#postToChannel
// and bot replies through server/guildbot.ts#reply (hunt 261117-0852-026).

// Discord refuses message content longer than this many characters. JS string
// length counts UTF-16 code units, never fewer than Discord's characters, so
// content whose length fits also fits Discord's count.
export const DISCORD_MAX_CONTENT = 2000;

const FENCE = "```";
const ZERO_WIDTH_SPACE = "\u200B";
const CUT_HEAD = "...";
const CUT_DETAIL = "\n... (truncated)";
const NOT_JSON = "(detail not shown: it cannot be written as JSON)";

// The content of one message: the head as given, then the detail, if any, as
// JSON in a sealed code block. It is never longer than DISCORD_MAX_CONTENT.
// It never throws, since a message it fails to build is lost like one Discord
// refuses. The detail is cut to the room the head leaves, and the block is
// left out when none of the detail fits. A head over the cap is cut and loses
// the detail.
export function fitContent(head: string, detail?: unknown): string {
  const fitHead =
    head.length <= DISCORD_MAX_CONTENT
      ? head
      : prefix(head, DISCORD_MAX_CONTENT - CUT_HEAD.length) + CUT_HEAD;
  const json = toJson(detail);
  if (json === undefined) {
    return fitHead;
  }
  const body = seal(json);
  const open = `${fitHead}\n\n${FENCE}\n`;
  const close = `\n${FENCE}`;
  const room = DISCORD_MAX_CONTENT - open.length - close.length;
  if (body.length <= room) {
    return open + body + close;
  }
  const kept = prefix(body, room - CUT_DETAIL.length).trimEnd();
  if (kept === "") {
    return fitHead;
  }
  return open + kept + CUT_DETAIL + close;
}

// The detail as indented JSON, or undefined when there is none to show. JSON
// cannot hold every value: stringify throws on a cycle or a BigInt, and then
// the block shows a marker in place of the detail.
function toJson(detail: unknown): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return NOT_JSON;
  }
}

// Puts a zero-width space after every backtick, so no ``` in the detail can
// end its code block early, and after every @, so a quoted mention cannot use
// the message's mention grant. A backslash would not do: Discord shows it as
// text inside a block, and the ``` after it still ends the block.
function seal(text: string): string {
  return text.replace(/[`@]/g, `$&${ZERO_WIDTH_SPACE}`);
}

// The first n code units of text, or one fewer when the nth starts a surrogate
// pair, so a cut never splits a character. Empty when n is not positive.
function prefix(text: string, n: number): string {
  if (n <= 0) {
    return "";
  }
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}
