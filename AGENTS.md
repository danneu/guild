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
- Do not deploy unless explicitly asked.

## Architecture

Traditional MVC web app: routes -> db query layer -> Nunjucks views.

Key directories:

- `server/routes/` - Koa route handlers, organized by feature (users, topics, admin, ...)
- `server/db/` - Postgres query layer. One file per domain (users.ts, topics.ts,
  convos.ts, ...), with custom query builders abstracting SQL.
- `server/middleware/` - Koa middleware (auth, CSRF, etc.)
- `server/services/` - Cross-cutting services
- `server/discord/`, `server/akismet/`, `server/cache3/` - integrations/subsystems
- `server/types/` - shared TypeScript types
- `views/` - Nunjucks templates (`.html`): layouts, macros, partials
- `public/` - Static assets (CSS, JS, vendored libs, images)
- `sql/` - Schema and migration files
- `img-proxy/` - Cloudflare Worker image proxy (separate subproject)

**Authentication:** Session-based auth. Role-based permissions via
`server/cancan.ts`. Roles (Admin, Mod, Member) gate capabilities.

**Asset pipeline:** Gulp concatenates and minifies CSS/JS into versioned bundles
in `dist/`. In development assets are served individually; in production the
bundled assets are served. Browser vendor libs are copied from `node_modules`
into `public/vendor/` by Gulp (`copyVendorDeps`) -- do not hand-vendor them.

**Config:** Environment variables are defined and validated in
`server/config.ts`. For local dev, create a `.env` file. The app runs with
defaults, but some features need API keys (email/SES, S3 uploads, Akismet,
Turnstile CAPTCHA, Discord).

**Database:** Complex forum schema -- users, topics, posts, private messages
(convos), subscriptions, plus roleplay-specific tables.

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
quotes), dice rolling and character management for roleplay, Akismet spam
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
  `ago.js` -> `public/js/`). Edit the `server/` source, not the copy.
- The `img-proxy/` worker runs TypeScript directly via Wrangler -- no separate
  compile step. See `img-proxy/AGENTS.md`.
