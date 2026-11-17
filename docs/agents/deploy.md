# Deploy, SQL changes and the Node runtime

Read this before you add a table or column, edit the Dockerfile or a
workflow, change the Node version, or run or plan a deploy. `AGENTS.md` links
here.

Do not deploy unless explicitly asked.

## Commands

- Production is the Fly app `rpguild`. `pnpm run prod:deploy` bumps the patch
  version and pushes tags; CI deploys on the `[deploy]` tagged commit.
- Logs: `pnpm run prod:logs`. SSH: `pnpm run prod:ssh`.
- `fly.staging.toml` and the `staging:*` scripts describe a staging app
  (`rpguild-staging`). Do not assume it is running.

## SQL changes

- Nothing applies SQL at deploy. A schema change is a new numbered file in
  `sql/` that a person applies to production by hand.
- State the order in the file's header: whether it must go in before the
  build that reads it, and whether the previous build still runs with it in
  place. `sql/14-screen-spends.sql` is the pattern.
- Prefer additive changes, so redeploying the previous build stays a working
  rollback.
- Make the same change in `sql/1-schema.sql`, which
  `pnpm run reset-db` loads for a fresh local database.
- Say in the commit body that the file is applied by hand.

## After a deploy

After a production deploy that touches `server/middleware/protect-csrf.ts`,
or a change to Cloudflare or Fly routing, run
`pnpm exec tsx scripts/csrf-probe.ts`. It checks through Cloudflare what the
CSRF gate trusts the proxies to pass on.

## The Node major

- The Dockerfile's base stage, `FROM node:<major>-alpine AS base`, owns the
  Node major and its end date. The other stages start from it, CI installs
  the major it names through `scripts/node-major.sh`, and `@types/node` must
  be on the same major.
- The `# node-eol:` line right above it holds that major's end-of-life date
  from Node's release schedule. `pnpm test` fails the day after that date, so
  deploys stop until the base stage moves to the next LTS major.
- The weekly watch (`.github/workflows/watch.yml`) checks the line against
  the schedule and starts failing ahead of the date
  (`scripts/node-runtime.mts#WARN_DAYS`).
- Move the base line, its node-eol line and `@types/node` together.
