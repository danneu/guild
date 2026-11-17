# AGENTS.md

Guidance for agents working in this repository.

## Project Overview

Guild is a role-playing forum, in production since 2006. Stack:
Node.js + TypeScript, Koa.js (v3), PostgreSQL, server-side rendering with
Nunjucks templates, and a Gulp asset pipeline. Deployed on Fly.io.

The repo is a pnpm workspace. The root app is the forum; `img-proxy/` is a
separate Cloudflare Worker subproject with its own `AGENTS.md`.

## Commands

Package manager is **pnpm** (`pnpm-lock.yaml`). Scripts also work via `npm run`.

- `pnpm run check` - TypeScript type checking (`tsc --noEmit`)
- `pnpm run dev` - Dev server with hot reload (`tsx watch ./server`)
- `pnpm start` - Run the server once (`tsx ./server`)
- `pnpm run build` - Build/bundle CSS+JS assets via Gulp into `dist/` (required for prod)
- `pnpm test` - Run tests (`vitest run`); `pnpm run test:watch` to watch
- `pnpm run prettier` - Format `server/**/*.ts`
- `pnpm run reset-db` - Reset the local database (`tsx ./server/reset_db.ts`)

**Before finishing a change, run `pnpm run check` and `pnpm test`.**

## Deploy

- Production (app `rpguild`): `pnpm run prod:deploy` (bumps patch version, pushes
  tags; CI/Fly deploys on the `[deploy]` tagged commit). Logs: `pnpm run prod:logs`.
  SSH: `pnpm run prod:ssh`.
- Staging (app `rpguild-staging`): `pnpm run staging:deploy` (`fly deploy --config
fly.staging.toml`). Logs/SSH via `staging:logs` / `staging:ssh`.
- After a production deploy that touches `server/middleware/protect-csrf.ts`,
  or a change to Cloudflare or Fly routing, run
  `pnpm exec tsx scripts/csrf-probe.ts`. It checks through Cloudflare what the
  CSRF gate trusts the proxies to pass on.
- Do not deploy unless explicitly asked.

## Architecture

Traditional MVC web app: routes -> db query layer -> Nunjucks views.

Key directories:

- `server/routes/` - Koa route handlers, organized by feature (users, topics, admin, ...)
- `server/db/` - Postgres query layer. One file per domain (users.ts, topics.ts,
  convos.ts, ...), with custom query builders abstracting SQL.
- `server/middleware/` - Koa middleware (auth, CSRF, etc.)
- `server/services/` - Cross-cutting services
- `server/discord/`, `server/cache3/` - integrations/subsystems
- `server/types/` - shared TypeScript types
- `views/` - Nunjucks templates (`.html`): layouts, macros, partials
- `public/` - Static assets (CSS, JS, vendored libs, images)
- `sql/` - Schema and migration files
- `img-proxy/` - Cloudflare Worker image proxy (separate subproject)

**Authentication:** Session-based auth. Role-based permissions via
`server/cancan.ts`. Roles (Admin, Mod, Member) gate capabilities. Each action
declares the target it reads as a zod schema in `server/cancan.ts#TARGETS`.
`can()` throws on an actor or a target that does not match, so a loader must
select every field its actions declare, and a rule cannot compile if it reads
a field its schema leaves out. `server/cancan.test.ts` fails unless every
action has exactly one sweep row, which lists the actors it allows on each
target.
`server/cancan.ts#grantableRoles` is the one list of who may set which role.
UPDATE_USER_ROLE, the role menu, and the profile edit, email gate and nuke
rules all read it. Change a role only through
`server/db/index.ts#updateUserRole` or `#unnukeUser`. Each locks the actor's
and the account's rows and asks the rule about their live roles before it
writes. `db.nukeUser` is checked only at its route, because the automatic
nukes have no staff actor.
`server/auth.ts` is the only module that hashes or checks a password, and a
test fails if any other file imports bcrypt. Log in through
`server/auth.ts#authenticate`, which never shows whether an account exists.
It charges every login to an attempt budget per typed identifier and per
network (`server/db/login_attempts.ts`) before any lookup or compare. Over a
soft limit it asks for a Turnstile challenge, or refuses when Turnstile is not
configured. At an identifier's hard cap it refuses even a solved challenge.
After signup, change a password only through
`server/db/index.ts#replacePasswordTx`, inside a transaction. It ends every
grant the old password left, other sessions included, before it issues the
new session.
A banned user (role `banned`) can read, and can write only through the
allowlist in `server/middleware/require-not-banned.ts`, which refuses every
other write before any route runs. A new write route that banned users should
keep goes on that allowlist on purpose. That gate and the email gate pass every
GET as a read, so the Discord join, a GET, checks both itself (see Discord
membership below).

**Cross-site writes:** `server/middleware/protect-csrf.ts` refuses a write
that another site's page sent, before any router runs. SameSite=Lax does not
cover the writes that need no session, such as login and signup, or pages on
other subdomains. The gate takes the browser's Sec-Fetch-Site when it is
sent, and otherwise needs Origin (or Referer, when Origin is absent) to name
the request's own host. Ask whether a URL names the request's own host only
through `server/request_host.ts#namesRequestHost`, with the raw Host header.

**Request bodies and uploads:** `server/middleware/body.ts` is the app-wide
body parser. It never parses multipart, and it leaves `ctx.request.body` as
`{}` for a body it does not read. Parse a file upload only through
`server/upload.ts#withUpload`, and call it after the route's own
authorization check. It keeps the file in memory, so no temp file exists, and
it draws on one byte budget per process. A test fails if any other file
imports koa-body or formidable.
Decode an uploaded image only through the transcodes `server/imaging.ts`
exports. It blocks every libvips loader but the few formats members upload,
caps the pixels an upload may decode to, and runs one transcode at a time. It
throws `ImageRefused`, which the route shows as a flash. A test fails if any
other file imports sharp.

**User html:** Pages print stored user html with `|safe`. Render BBCode, and
scan markup for mentions and quotes, only through the exports of
`server/markup.ts`. A test fails if any other non-test server module imports
`server/bbcode.js`. The owner refuses markup longer than `MAX_POST_LENGTH`
and cuts off work that runs past `MARKUP_BUDGET_MS`. It then refuses that
user's markup work for `MARKUP_COOLDOWN_MS`. Each refusal throws
`MarkupRejected`. The error handler in `server/index.ts` answers an `/api/`
request with a 400 and the reason as text, and gives a form post the reason
as a flash. The render ends in `server/user_html.ts#sanitizeUserHtml`. Any other
code that stores user html calls `sanitizeUserHtml` itself, and none copies
stored html from another row. In `server/bbcode.js` a tag writes user text
into an attribute only through `attrValue`, and checks a URL only through
`parseSafeUrl`. `server/bbcode.test.ts` sweeps every tag against the
sanitizer's allowlist, and fails any tag or shape whose render costs far more
than plain text of the same length.

**Asset pipeline:** Gulp concatenates and minifies CSS/JS into versioned bundles
in `dist/`. In development assets are served individually; in production the
bundled assets are served. Browser vendor libs are copied from `node_modules`
into `public/vendor/` by Gulp (`copyVendorDeps`) -- do not hand-vendor them.

**Config:** Environment variables are defined and validated in
`server/config.ts`. For local dev, create a `.env` file. The app runs with
defaults, but some features need API keys (email/SES, S3 uploads, Claude
antispam, Turnstile CAPTCHA, Discord).

**Database:** Complex forum schema -- users, topics, posts, private messages
(convos), subscriptions, plus roleplay-specific tables.
Load a topic or forum by id only through `db.loadTopicFor` or
`db.loadForumFor` (`server/db/readable.ts`). They check READ_TOPIC or
READ_FORUM before they return a row. Add any new by-id topic or forum query
there as a private function, never as an export of `server/db`.
Run a viewer's paged list of posts or topics that spans topics only through
`server/readable.ts#fetchReadable`. It adds the read scope in SQL before the
limit or cap, then checks each row with cancan. Filtering rows after the
query still leaks through page sizes. The topic page stays out: it asks
READ_POST about each post, so GMs still see hidden posts in their own topics.
Create a notification that points at a post or a topic, read its post html
or topic title, and list a user's subscribed topics only through the exports
of `server/db/notifications.ts`. It gates each recipient and each row with
READ_POST or READ_TOPIC on live rows. Its reads delete the notifications
that fail and keep the subscriptions. Lookups by id and deletes return only
pointer columns, so they need no gate; most of them stay in
`server/db/index.ts`.

**Member sends:** A send is a message a member writes to other members
outside the forums. Each send pays a per-account budget through
`server/db/send_budget.ts#spend`, and the callers of spend in
`server/db/index.ts` are the full set of sends. Topics and posts are not
sends. `server/db/post_gap.ts#admitPost` spaces each member's new posts and
topics instead, and `server/services/antispam/index.ts#process` checks them
for spam. `server/db/index.ts#createPost` and `#createTopic` call admitPost in
their own transaction, after lockStanding and before the insert. They are the
only code that inserts posts, and a test fails on any other
`INSERT INTO posts`. Each send's write function calls spend in its own
transaction, before its insert, and sets its own cost; routes never pass one.
Over budget, spend throws `SendBudgetExceeded` and nothing is written, and the
route shows that as a flash. Only the staff welcome PM skips the budget,
through the staff variant of `server/db/index.ts#ConvoSender`. A new kind of
send needs the same call, and nothing fails if it is missing. A send takes
`server/db/send_budget.ts#lockSender` before any other lock on its sender, or
two sends can deadlock.

**Spam screening:** A call that sends member text to the spam classifier
needs a `ScreeningCharge`, and only
`server/db/screen_budget.ts#spendScreening` makes one. It prices the
exact payload the classifier sends and charges it to a per-account budget,
which also paces calls per minute. A write that stores text to screen reads
its actor once through `server/db/send_budget.ts#lockStanding`, which takes
lockSender first. It charges in its own transaction, before its insert, and
returns the charge with its row. The route hands that charge to
`server/services/antispam/index.ts#process`. A null charge means a trusted
actor, and no call. Over budget, spendScreening throws
`ScreeningBudgetExceeded` and nothing is written; the error handler in
`server/index.ts` answers it as it answers `MarkupRejected`. The post and
topic writes in `server/db/index.ts` all charge, but not every route that
calls them hands the charge on yet, so a paid charge does not mean the text
was screened.
Every classifier failure fails open to ALLOW. So in production each machine
runs `server/services/antispam/claude.ts#probe`, the one call without a
charge, at boot and on a timer
(`server/services/antispam/index.ts#startClassifierProbe`). It sends a fixed
sample, and posts a Discord note when no verdict comes back.
`SpamVerdictSchema` in `claude.ts` is both the request's output format and
the parser of the reply. Give it only keywords the API enforces;
`claude.test.ts` fails on any other.

**Discord membership:** `server/discord/join.ts#joinDiscord` is the only code
that changes a member of the Discord server: adding one, or setting a
member's roles or nick. The bot's per-member endpoints are private there, and
`server/discord/join.test.ts` fails on a per-member path or a discord.js member
write anywhere else in `server/`. Channel messages about a member's actions
are not member writes and go through `server/services/discord.ts`. The join
runs on GET /discord/callback, which both write gates pass, so joinDiscord
refuses a banned or unconfirmed account itself, before any Discord call.
Before it adds anyone, it claims the account's row in `discord_links`
(`server/db/discord_links.ts`) and refuses a Discord id other than the one
the row holds. Staff may delete a row so a member can switch Discord
accounts. That is an explicit exception: the old account stays in the server,
so the row limits a forum account to one Discord account at a time, not over
its life.

## Forum domain model

The homepage shows a couple dozen forums grouped into categories. Some `forums`
rows have an `is_roleplay` boolean flag.

A defining feature: topics inside roleplay forums have three tabs --

- **OOC** - Out of Character
- **IC** - In Character
- **CHAR** - Character

There is nothing structurally special about these tabs or their posts; all three
behave like normal posts. Non-roleplay forums have only the single OOC tab.

Other forum features: BBCode parser for posts (formatting, links, mentions,
quotes), dice rolling and character management for roleplay, Claude-based spam
detection + user reporting + mod tools, and integrations with Discord (bot),
AWS S3 (file storage), AWS SES (email), and Cloudflare Turnstile (CAPTCHA).

## Code style

- Prefer TypeScript `type` over `interface`.
- Define top-level functions with `function foo() {}`, not `const foo = () => {}`.
- Match the surrounding file's conventions; run `pnpm run prettier` on touched
  `server/**/*.ts` (config in `.prettierrc`).
- Plain ASCII over fancy Unicode (`--` not em-dash, straight quotes) unless the
  surrounding file already uses the Unicode form.

## Gotchas

- Some `server/` code is still `.js` (e.g. `server/bbcode.js`), and a few files
  are copied into `public/` by Gulp (`bbcode.js` -> `public/vendor/xbbcode/`,
  `ago.js` -> `public/js/`). Edit the `server/` source, not the copy. The
  copies are tracked and dev serves them as-is, so regenerate them with
  `pnpm exec gulp copyServerFiles` and commit them with the source.
- The `img-proxy/` worker runs TypeScript directly via Wrangler -- no separate
  compile step. See `img-proxy/AGENTS.md`.
- Only `ctx.render` output goes out as HTML. Any other string or Buffer body
  with an html type, sniffed or set by hand, is sent as text/plain (see
  `server/middleware/response-edge.ts`). Build new HTML pages as views.
- Never print a field that can hold raw author text, such as `markup`, as
  HTML. Every nunjucks unescape in `views/` or `server/` needs an exact
  reviewed entry in `server/template_safe_sweep.test.ts`, which defines what
  counts as one.
- JSON goes out only through `server/api_json.ts#sendJson`, which sends a named
  view listing each field a client reads. Any other body Koa would
  JSON-encode, such as a db row, answers 500 at
  `server/middleware/response-edge.ts`, and `pnpm test` fails on a handler
  that stringifies a body or sets a JSON type itself. Add a view instead.
- Every cookie the server sets is HttpOnly and SameSite=Lax, and Secure when
  `HOST` is https, whatever options the call passes (see
  `server/cookie-policy.ts#installCookiePolicy`). Behind Fly, TLS ends before
  Node, so `ctx.secure` and `ctx.protocol` say http: never decide anything on
  them.
