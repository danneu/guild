# Discord

Read this before you add, remove or change a member of the Discord server,
set a Discord role or nick, touch the OAuth join, or add or change a message
the forum or the bot sends. `AGENTS.md` links here.

## Membership

- `server/discord/join.ts#joinDiscord` is the only code that changes a member
  of the Discord server: adding one, or setting a member's roles or nick.
- The bot's per-member endpoints are private there.
  `server/discord/join.test.ts` fails on a per-member path or a discord.js
  member write anywhere else in `server/`.
- Channel messages about a member's actions are not member writes. They go
  through `server/services/discord.ts`.

## Messages

- `server/discord/content.ts#fitContent` builds the content of every message
  the forum sends. It keeps the content under Discord's length cap, which
  Discord enforces by refusing the whole message. It seals the detail inside
  its code block, so a quoted ``` or mention cannot break out.
- Broadcasts send only through `server/services/discord.ts#postToChannel`,
  and bot replies only through `server/guildbot.ts#reply`. Both call
  fitContent. Nothing checks this: a send that goes around them is refused
  when it runs long, and the alert or reply is lost.
- The detail is data shown as JSON in a sealed code block, and it is cut
  first. The head is shown as written: it is cut only when it alone passes
  the cap, and it is never sealed. So put the links a reader needs in the
  head, and data of any size, such as a spam verdict, in the detail.
- A short snippet that a broadcast cuts itself, such as a post or bio
  snippet, may stay in the head when the message grants no mentions, since
  nothing in it can then ping.

## The join

- The join runs on GET /discord/callback, which both write gates pass. So
  joinDiscord refuses a banned or unconfirmed account itself, before any
  Discord call.
- Before it adds anyone, it claims the account's row in `discord_links`
  (`server/db/discord_links.ts`) and refuses a Discord id other than the one
  the row holds.
- Staff may delete a row so a member can switch Discord accounts. That is an
  explicit exception: the old account stays in the server. So the row limits
  a forum account to one Discord account at a time, not over its life.
