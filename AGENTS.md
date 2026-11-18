# AGENTS.md

Guidance for agents working in this repository. Keep this file short: it is
sent with every task. Put detail in the owner file's header comment, or in a
`docs/agents/` article when the topic spans files, and add one row here.

## Project

Guild is a role-playing forum, in production since 2006: Node.js +
TypeScript, Koa.js (v3), PostgreSQL, Nunjucks views rendered on the server, a
Gulp asset pipeline, deployed on Fly.io. The repo is a pnpm workspace. The
root app is the forum. `img-proxy/` is a separate Cloudflare Worker with its
own `AGENTS.md`.

## Commands

- `pnpm run check` -- type check. `pnpm test` -- tests (vitest).
- `pnpm run dev` -- dev server with reload. `pnpm start` -- run once.
- `pnpm run build` -- bundle assets into `dist/` (production needs it).
- `pnpm run prettier` -- format `server/**/*.ts`.
- `pnpm run reset-db` -- rebuild the local database. It wipes local data.

**Before finishing a change, run `pnpm run check` and `pnpm test`.**
**Do not deploy unless explicitly asked.**

## Read before you write

Most rules here have one owner module, and a test fails when other code goes
around it. Read the article **before** you write code when your task matches
its row, not after a test fails.

| Read | When your task... |
| --- | --- |
| [auth](docs/agents/auth.md) | touches login, signup or its human test, sessions, passwords, roles, bans, the email gate, or a `can()` check |
| [requests and responses](docs/agents/requests-and-responses.md) | adds a write route, reads a request body, returns JSON or HTML outside a view, sets a cookie, or compares a URL with the request's host |
| [user html](docs/agents/user-html.md) | renders BBCode, stores html a member wrote, edits `server/bbcode.js`, or adds `\|safe` to a template |
| [read scope](docs/agents/read-scope.md) | loads a topic, forum or post by id, lists posts or topics across topics, or creates or reads a notification |
| [budgets](docs/agents/budgets.md) | adds or changes a write a member can repeat: a post or an edit of one, a topic or its title, a PM or other send, or a spam classifier call |
| [uploads](docs/agents/uploads.md) | parses a file upload, decodes an image with sharp, or stores or removes anything in S3 |
| [discord](docs/agents/discord.md) | adds or changes a member of the Discord server, or touches the OAuth join |
| [deploy](docs/agents/deploy.md) | adds a table or column, edits the Dockerfile or a workflow, changes the Node version, or plans a deploy |

## Layout

Routes -> db query layer -> Nunjucks views.

- `server/routes/` -- Koa route handlers, by feature.
- `server/db/` -- Postgres queries, one file per domain.
- `server/middleware/`, `server/services/`, `server/discord/`,
  `server/cache3/`, `server/types/`.
- `server/config.ts` -- every environment variable, with defaults. Local dev
  reads `.env`. Some features need API keys.
- `views/` -- templates. `public/` -- static assets. `sql/` -- schema and
  hand-applied changes.

## Domain

Forums are grouped into categories. A topic in a roleplay forum
(`forums.is_roleplay`) has three tabs: OOC (out of character), IC (in
character) and CHAR (character). Other forums have only OOC. Posts in all
three tabs are ordinary posts.

## Rules that apply everywhere

- **Nothing fails if you miss these.** A new kind of member send must call
  `server/db/send_budget.ts#spend`. Check a per-account limit inside the write
  it limits, behind `lockSender`. A GET that writes must check the ban and
  email gates itself. See [budgets](docs/agents/budgets.md) and
  [auth](docs/agents/auth.md).
- **Never drop a promise in server code.** Node exits on an unhandled
  rejection, and on an 'error' event that no listener hears. Await a promise,
  return it, or end it in `.catch(handler)`. `server/promise_sweep.test.ts`
  fails otherwise, but it reads static types, so a value typed any gets past
  it. Make pg connections only in `server/db/util.ts`.
- **Generated copies.** Gulp copies `server/bbcode.js` and `server/ago.js`
  into `public/`. Edit the `server/` source, then run
  `pnpm exec gulp copyServerFiles` and commit the copies with it. Gulp also
  copies browser vendor libs from `node_modules` into `public/vendor/`
  (`copyVendorDeps`); do not hand-vendor them. It bundles `client/` into
  `public/bundle/` (`bundleSearch`), which git does not hold. Views load
  code only from the forum; see
  [requests and responses](docs/agents/requests-and-responses.md#browser-code).
- **Behind Fly, TLS ends before Node.** `ctx.secure` and `ctx.protocol` say
  http. Never decide anything on them.

## Code style

- Prefer TypeScript `type` over `interface`.
- Define top-level functions with `function foo() {}`, not
  `const foo = () => {}`.
- Match the surrounding file's conventions. Run `pnpm run prettier` on
  touched `server/**/*.ts`.
- Plain ASCII over fancy Unicode (`--` not em-dash, straight quotes) unless
  the surrounding file already uses the Unicode form.
