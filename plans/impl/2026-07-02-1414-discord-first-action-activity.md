# Discord #forum-activity: replace registration spam with first-action events

## Context

Bots now defeat Cloudflare's CAPTCHA and register en masse. The `broadcastUserJoin`
event fires on every registration (with an `@here` ping), so the Discord
`#forum-activity` channel -- which exists so guild moderators can spot abuse -- is
~95% registration spam and effectively useless.

Registration is a *pre-action* signal and is now worthless. The fix is to stop
broadcasting registrations and instead broadcast a new user's first *actions*,
which are what actually matter for moderation and which link to content a mod can
act on:

- **First post** -- snippet + link to the post, plus the spam-classifier outcome so
  mods know whether it passed the Claude antispam check or the check failed-open
  (timeout/error) and needs manual review.
- **First PM (new conversation)** -- privacy-preserving: who the new user messaged
  (recipient uname + profile link) and a link to the sender's profile. No PM content.

Both always link the actor's profile. Bots that register and never act drop out of
the feed entirely; bots that do act now show up attached to actionable content.

## Decisions (from clarification)

- **First-post + REVIEW/NUKE:** `broadcastFirstPost` fires ONLY when the post cleanly
  passed or the classifier failed-open. REVIEW and NUKE already have their own alerts
  (`broadcastSpamReview` / `broadcastAutoNuke`), so no duplicate message.
- **First-PM frequency:** fire only on the sender's *first* started convo AND only
  when they have 0 posts.
- **First PM is metadata-only** -- do not run the PM body through the classifier.
- **Akismet cleanup is out of scope** (the `server/akismet/` and
  `server/services/antispam/akismet.ts` dead code is left for a separate task).

## Key facts grounding the design

- `ctx.currUser` is a request-start snapshot (`server/middleware/index.ts:14-27`).
  The `posts_count` column is bumped by a Postgres `AFTER INSERT` trigger
  (`sql/3-drop-plv8.sql:21-57`), NOT by app code, so the in-memory
  `ctx.currUser.posts_count` still reads **0 for a genuine first post** at the time
  `antispam.process` runs -- and is `>= 1` on an edit. This is the first-post signal.
- `antispam.process(ctx, markup, postId, title?)` (`server/services/antispam/index.ts`)
  is already called at all three post write paths in `server/index.ts`: reply create
  (`:1190`, fire-and-forget), topic create (`:1407`, awaited, result gates the intro
  broadcast), edit (`:1518`, fire-and-forget). It already owns the spam Discord
  side-effects and has `ctx.currUser`, `markup`, `postId`, and the `AnalyzeResult` in
  scope. `decideAction` fails open: timeout/API-error -> ALLOW (`policy.ts:16`), so a
  failed-open post is currently indistinguishable from a clean pass to callers.
- `POST /convos` (`server/routes/convos.ts:32`) has the full recipient records in
  scope as `users` (each a `DbUser` with `.slug`/`.uname`) and `ctx.currUser.posts_count`.
  The registration "welcome package" convo is created directly with `db.createConvo`
  and the new user is the *recipient* (`server/routes/users.ts:303-335`), so it never
  hits this route -- hooking `POST /convos` won't fire on welcome activity or on
  replies (`POST /convos/:convoId/pms`).
- URLs: `presentUser` sets `user.url = "/users/" + slug`; `presentPost` sets
  `post.url = "/posts/" + id`. Absolute = `` `${config.HOST}${x.url}` `` (pattern used
  throughout `server/services/discord.ts`).
- Snippet: reuse `belt.truncate(markup, 280)` (`server/belt.ts:133`) -- slices, trims,
  appends `...` only when actually truncated. No BBCode-stripping util exists;
  precedent (`broadcastBioUpdate`, `emailer.ts:207`) slices raw markup, so we do too.

## Changes

### 1. DRY the broadcast channel-lookup (`server/services/discord.ts`)

Every broadcast fn repeats: `makeClient()` null-guard, `listGuildChannels(GUILD_ID)`
-> `find(c => c.name === ...)`, missing-channel guard, `createMessage(channel.id, {content})`.
The file already carries a `TODO: DRY up these functions`. Extract:

```ts
type BroadcastOpts = { allowedMentions?: { parse: ("everyone" | "roles" | "users")[] } };

// Central broadcaster. Genuine no-op (not a throw) when Discord is unconfigured.
// Defaults to SUPPRESSING all mentions so relaying user-generated content (post
// snippets, unames) can never ping the channel; callers that intentionally alert
// (@here) opt in via `allowedMentions`.
async function postToChannel(
  channelName: string,
  content: string,
  opts: BroadcastOpts = {},
): Promise<void> {
  // A broadcast needs ONLY the bot token (to auth the client) and the guild id (to look
  // up the channel). It does NOT need the OAuth vars DISCORD_APP_CLIENTID /
  // DISCORD_APP_CLIENTSECRET, so guard on the narrow pair -- NOT config.IS_DISCORD_CONFIGURED,
  // which ANDs in those two OAuth-only vars (config.ts:154-159). Guarding on the wide flag
  // would silently no-op every broadcast on a bot-only setup, including this plan's own E2E
  // (which sets only DISCORD_BOT_TOKEN / DISCORD_GUILD_ID). This narrow check also keeps
  // listGuildChannels(DISCORD_GUILD_ID!) from asserting/throwing when the guild id is absent,
  // so it stays a true no-op (not a throw) when unconfigured.
  if (!config.DISCORD_BOT_TOKEN || !config.DISCORD_GUILD_ID) {
    console.warn(`[discord] bot token / guild id not set; skipping #${channelName}`);
    return;
  }
  const client = makeClient(); // non-null here (bot token present), but keep the guard for TS
  if (!client) return;
  const channel = await client
    .listGuildChannels(config.DISCORD_GUILD_ID!)
    .then((cs) => cs.find((c) => c.name === channelName));
  if (!channel) { console.warn(`[discord] no #${channelName} channel found`); return; }
  await client.createMessage(channel.id, {
    content,
    allowed_mentions: opts.allowedMentions ?? { parse: [] },
  });
}
```

Refactor the existing broadcasters to build their `content` then delegate to
`postToChannel("forum-activity", content)` (or `"general"` for `broadcastIntroTopic`).
Keep each function's `pre.presentUser(...)` / assertions / message text as-is; only the
lookup+post block is replaced. **Also drop each broadcaster's own readiness guard** --
`broadcastManualNuke`, `broadcastAutoNuke`, and `broadcastSpamReview` currently early-return
on `if (!config.IS_DISCORD_CONFIGURED)`, and every function repeats a `makeClient()`
null-return. Delete those per-function guards: the single narrow check now lives in
`postToChannel`, so leaving the OAuth-wide `IS_DISCORD_CONFIGURED` guards in place would keep
those three broadcasters silently no-op'ing on a bot-only setup (the very bug this fixes).
After the refactor, exactly one readiness contract (bot token + guild id) governs all
broadcasts.

**Mention safety (do not drop this in the refactor):** the two broadcasters that
intentionally ping -- `broadcastAutoNuke` and `broadcastIpAddressAutoNuke`, both of
which embed `@here` -- must pass `{ allowedMentions: { parse: ["everyone"] } }` so their
`@here` still resolves. (`broadcastUserJoin`, the other `@here` user, is being removed in
Change 2.) Every other broadcaster, and both new first-action broadcasters below, use the
default `{ parse: [] }`. `createMessage`'s body type
(`RESTPostAPIChannelMessageJSONBody`) already includes `allowed_mentions`, so no client
change is needed. This closes the ping-abuse hole: a spammer's first post markup can no
longer smuggle `@everyone`/`@here`/`<@id>` into the mod channel.

### 2. Stop broadcasting registrations (`server/routes/users.ts:337-340`)

Comment out the `services.discord.broadcastUserJoin(user)` call with a note:

```ts
// Registration events are no longer broadcast to Discord: bots now defeat the
// CAPTCHA and register en masse, which drowned #forum-activity in ~95% spam.
// Mods instead get a new user's first *actions* (first post, first PM) below /
// via antispam.process. See broadcastFirstPost / broadcastFirstConvo.
// services.discord.broadcastUserJoin(user).catch(...)
```

`broadcastUserJoin` itself can stay defined (unused) or be removed; leaving it is fine.

### 3. `broadcastFirstPost` (`server/services/discord.ts` + `server/services/antispam/index.ts`)

New broadcaster:

```ts
export async function broadcastFirstPost(
  user, postId: number,
  antispam: { ran: true } | { ran: false; error: "API_TIMEOUT" | "API_ERROR" },
  markup: string,
) {
  pre.presentUser(user);
  const snippet = belt.truncate((markup || "").replace(/\s+/g, " ").trim(), 280);
  const status = antispam.ran
    ? ":white_check_mark: passed spam check"
    : `:warning: spam check did NOT run (${antispam.error}) -- manual review recommended`;
  const content =
    `:memo: First post by ${config.HOST}${user.url} -- ${status}\n` +
    `> ${snippet}\n${config.HOST}/posts/${postId}`;
  // Default `{ parse: [] }` from postToChannel: the snippet is raw attacker-controlled
  // markup, so mentions in it must never ping the channel.
  await postToChannel("forum-activity", content);
}
```

Call it from INSIDE `antispam.process`, in the `ALLOW` branch only (which is exactly
"not nuked and not flagged for review", and covers both clean-pass and fail-open):

```ts
const action = decideAction(result);
if (action === "ALLOW") {
  // Genuine first post (in-memory posts_count is the pre-request snapshot; edits are >= 1).
  if (ctx.currUser.posts_count === 0) {
    const antispam = result.ok ? { ran: true } : { ran: false, error: result.error };
    broadcastFirstPost(ctx.currUser, postId, antispam, markup).catch((err) =>
      console.error("broadcastFirstPost failed", err));
  }
  return;
}
// NUKE / REVIEW unchanged below
```

This requires **no changes to the three `index.ts` call sites** and **no change to
`process()`'s return type** -- the existing `index.ts:1415` intro-topic gate
(`if (!result ...)`) still sees `undefined` for ALLOW. The `posts_count === 0` gate
naturally: (a) fires for first post via reply or topic, (b) excludes edits, (c) never
collides with the `posts_count > 5` bail. Note: approved users (`approved_at` set) bail
before the classifier, so their first post won't broadcast -- acceptable, they're vetted.

Add `broadcastFirstPost` to the existing `import { ... } from "../discord"` in
`antispam/index.ts`, and import `belt` in `discord.ts` if not already.

### 4. `broadcastFirstConvo` (`server/services/discord.ts` + `server/routes/convos.ts`)

New broadcaster (metadata-only, no `@here`, handles multiple recipients):

```ts
export async function broadcastFirstConvo(sender, recipients) {
  pre.presentUser(sender);
  recipients.forEach(pre.presentUser);
  const to = recipients
    .map((r) => `**${r.uname}** (${config.HOST}${r.url})`)
    .join(", ");
  const content =
    `:love_letter: New user ${config.HOST}${sender.url} started their first ` +
    `conversation with ${to}`;
  await postToChannel("forum-activity", content);
}
```

**Decide "first started convo" INSIDE the existing transaction, not after commit.** A
post-commit count is race-prone: two concurrent `POST /convos` from the same zero-post
user each read a stale count and could both broadcast (or both suppress). Compute the
decision inside `withPgPoolTransaction` (which `POST /convos` already uses to call
`db.createConvo`), serialized by a row lock, and return the boolean out:

```ts
const { convo, isFirstStartedConvo } = await withPgPoolTransaction(pool, async (pgClient) => {
  // Only new (0-post) users are candidates, so skip the lock/read for everyone else.
  const isFirstStartedConvo =
    ctx.currUser.posts_count === 0
      ? await db.isFirstStartedConvo(pgClient, ctx.currUser.id) // BEFORE createConvo
      : false;

  const convo = await db.createConvo(pgClient, { userId: ctx.currUser.id, /* ... */ })
    .then((c) => pre.presentConvo(c)!);
  // ... existing convo-notification + email bulk inserts, unchanged ...
  return { convo, isFirstStartedConvo };
});

ctx.response.redirect(convo.url);

// Broadcast OUTSIDE the transaction (never hold the row lock across a Discord HTTP call),
// fire-and-forget so it adds no latency. Metadata only, no PM content.
if (isFirstStartedConvo) {
  services.discord
    .broadcastFirstConvo(ctx.currUser, users)
    .catch((err) => console.error("broadcastFirstConvo failed", err));
}
```

Add the decision helper in the convos db layer. It locks the sender's `users` row so
concurrent convo-creates by the same user serialize, then checks for any pre-existing
started convo. It MUST be called before `createConvo` inserts the new row, so "none
found" means this is their first:

```ts
// True iff `userId` has not started any convo yet. Locks the user row (FOR UPDATE) so a
// concurrent POST /convos from the same user blocks until this txn commits and then
// correctly sees the row. Excludes convos they only RECEIVE (e.g. the welcome package,
// whose user_id is the staff rep), since it filters on convos.user_id = the creator.
// Call inside the same transaction as createConvo, BEFORE the insert.
export async function isFirstStartedConvo(pgClient, userId: number): Promise<boolean> {
  await pgClient.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  const { rows } = await pgClient.query(
    `SELECT 1 FROM convos WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows.length === 0;
}
```

Match the file's actual query-builder / pgClient conventions when implementing (see the
existing `createConvo` and other in-transaction functions in `server/db/index.ts` for the
exact `pgClient` param style and export path used by `db.createConvo`).

## Files to modify

- `server/services/discord.ts` -- add `postToChannel` helper; refactor existing
  broadcasters onto it; add `broadcastFirstPost` and `broadcastFirstConvo`.
- `server/services/antispam/index.ts` -- call `broadcastFirstPost` in the ALLOW branch.
- `server/routes/users.ts` -- comment out `broadcastUserJoin` call.
- `server/routes/convos.ts` -- compute `isFirstStartedConvo` in the existing transaction;
  hook `broadcastFirstConvo` after redirect.
- `server/db/index.ts` (or the convos db module) -- add `isFirstStartedConvo` (in-txn,
  row-locked).

## Tests

Extend `server/services/antispam/index.test.ts` (it already mocks `../discord`):

- Add `broadcastFirstPost: vi.fn()` to the `vi.mock("../discord", ...)` factory.
- **First post + clean ALLOW** (`makeCtx()` posts_count 0, `analyze` ok + not spam):
  `broadcastFirstPost` called once with `{ ran: true }`.
- **First post + fail-open** (`analyze` -> `{ ok: false, error: "API_TIMEOUT" }`):
  called once with `{ ran: false, error: "API_TIMEOUT" }`.
- **First post + REVIEW** and **+ NUKE**: `broadcastFirstPost` NOT called (only
  spamReview / autoNuke fire).
- **Not a first post** (`makeCtx({ posts_count: 3 })`, clean ALLOW):
  `broadcastFirstPost` NOT called.
- Update the two existing ALLOW-path tests ("ALLOW (not spam)" and "API error/timeout")
  which currently assert *no* broadcasts -- they use `posts_count: 0` and will now
  legitimately trigger `broadcastFirstPost`; adjust their expectations accordingly
  (or set `posts_count` > 0 if the test's intent is purely the non-first-post wiring).

These assert behavior (which event fires for which verdict/first-post state), not
message wording, so they're structure-insensitive.

**First-PM decision (`isFirstStartedConvo`).** Add a unit test with a mocked `pgClient`
(same collaborator-mock style as `antispam/index.test.ts`), asserting behavior:

- No prior started convo (existence `SELECT` returns `rows: []`) -> returns `true`.
- Has a prior started convo (returns `rows: [{}]`) -> returns `false`.
- Issues the `FOR UPDATE` lock on the `users` row before the existence check (assert both
  `pgClient.query` calls happen, lock first) -- guards the concurrency fix from silent
  regression.

This is the regression-prone logic (the count/lock), and it fails `pnpm test` if the
gate is reverted.

**Mention safety (`allowed_mentions`).** Add a unit test on the broadcast layer with a
mocked Discord `Client` (assert on the `createMessage` body): a first-action broadcast
sends `allowed_mentions: { parse: [] }`, and an `@here` broadcaster (`broadcastAutoNuke`)
sends `{ parse: ["everyone"] }`. This pins the ping-abuse fix so a future edit can't
silently reintroduce mention parsing on relayed user content.

**Route-level test is out of scope (deliberate).** The reviewer asked for a Vitest
route-level test of `POST /convos`. The repo has no supertest / app-export / route
harness -- the three existing test files (`cache3`, `antispam/policy`, `antispam/index`)
are all unit tests with mocked collaborators. Standing up HTTP-route testing for a
`koa-bouncer` handler (`ctx.validateBody`, `ctx.assertAuthorized`, `withPgPoolTransaction`)
is disproportionate to this change and would be structure-sensitive. The decision logic
is instead covered by the `isFirstStartedConvo` unit test above; the remaining route
wiring (`if (isFirstStartedConvo) broadcast`) is a thin conditional covered by the manual
verification below. If a route harness is added later, the three-case route test
(first 0-post convo broadcasts / second does not / established user does not) is the
natural place to add it.

## Verification

1. `pnpm run check` and `pnpm test` pass.
2. Local end-to-end with Discord configured against a test channel named
   `forum-activity` (set `DISCORD_BOT_TOKEN` / `DISCORD_GUILD_ID`):
   - Register a fresh user -> confirm **no** join message posts.
   - As that user, create a first post -> confirm one `:memo: First post ...` message
     with a working snippet + `/posts/:id` link and `passed spam check`.
   - Post a first post whose body contains `@everyone` / `@here` -> confirm the Discord
     message renders the text but produces NO ping (mention suppression working).
   - Simulate fail-open (temporarily unset `ANTHROPIC_API_KEY` so `analyze` returns
     `API_ERROR`) -> a *different* fresh user's first post shows the
     `:warning: ... manual review recommended` variant.
   - Start a new convo from a 0-post user -> confirm one `:love_letter:` message with
     recipient uname + profile link; starting a second convo posts nothing; a reply to
     the welcome package posts nothing; editing the first post posts nothing.
3. Confirm an established user (posts_count > 0) posting/PMing produces no first-* events.
