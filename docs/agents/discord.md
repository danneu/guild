# Discord

Read this before you add, remove or change a member of the Discord server,
set a Discord role or nick, or touch the OAuth join. `AGENTS.md` links here.

## Membership

- `server/discord/join.ts#joinDiscord` is the only code that changes a member
  of the Discord server: adding one, or setting a member's roles or nick.
- The bot's per-member endpoints are private there.
  `server/discord/join.test.ts` fails on a per-member path or a discord.js
  member write anywhere else in `server/`.
- Channel messages about a member's actions are not member writes. They go
  through `server/services/discord.ts`.

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
