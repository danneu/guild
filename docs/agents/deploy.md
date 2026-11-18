# Deploy, CI pins, SQL changes and the Node runtime

Read this before you add a table or column, edit the Dockerfile or a
workflow, change the Node version, or run or plan a deploy. `AGENTS.md` links
here.

Do not deploy unless explicitly asked.

## Commands

- Production is the Fly app `rpguild`. `pnpm run prod:deploy` bumps the patch
  version and pushes tags; CI deploys on the `[deploy]` tagged commit.
- To roll back, dispatch `.github/workflows/rollback.yml` from master and
  give it the old tag. Its header says why.
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

## CI pins

- CI tools pin by content. Every `uses:` under `.github/` names a full
  commit SHA, with its version in a comment. Dependabot
  (`.github/dependabot.yml`) moves them in one weekly PR.
- Only `.github/workflows/fly-deploy.yml` installs flyctl or holds
  `FLY_API_TOKEN`; `deploy.yml` and `rollback.yml` call it. It downloads one
  flyctl release and checks it against a sha256 committed beside the
  version. Dependabot cannot move those two; the file's header says how.
- The runtime base tracks its LTS tag. The Dockerfile base stage (see
  [the Node major](#the-node-major)) keeps its tag because the tag moves
  with Node and Alpine fixes. A digest would hold those fixes back until
  someone merged a refresh. Any other external image needs a digest.
- `server/ci_pins.test.ts` fails `pnpm test` on a movable ref, on flyctl or
  the token anywhere but that one step and the calls that hand the token to
  it, on a flyctl that runs without passing its hash check, and on an
  external image other than the base stage with no digest.
- Accepted exceptions: `claude-code-review.yml` runs
  anthropics/claude-code-action, which installs Claude Code through
  claude.ai/install.sh and Bun through oven-sh/setup-bun. Each comes at a
  version the action's own code names, with no hash committed here.
  Anthropic, whose service the API key reaches, serves both: it has owned
  Bun since December 2025.
- The repository setting Settings > Actions > General > "Require actions to
  be pinned to a full-length commit SHA" also covers the refs inside an
  action, which the test cannot see. It lives outside git, so this note
  records that it should be on.

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
