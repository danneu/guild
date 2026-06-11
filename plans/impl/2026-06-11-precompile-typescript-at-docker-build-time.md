# Precompile TypeScript at Docker build time (kill the ~30s boot)

## Context

Production (Fly app `rpguild`, 8x shared-cpu-1x@512MB) currently starts with `pnpm start` -> `tsx ./server`, transpiling ~70 TS files at runtime on a small shared CPU. Measured: ~30s from machine start to port 3000 listening (~11s pnpm/entrypoint overhead + tsx compile). This exceeded Fly's proxy connect timeout and the 20s health-check grace period, causing 502s on cold starts. Auto-stop is already disabled as mitigation (uncommitted `fly.toml` change - keep it), but every deploy and crash restart still eats the slow boot. Fix: compile at image build time, start with plain `node`.

**Key facts (verified):**
- The codebase is **CommonJS**: no `"type": "module"` in package.json, tsconfig `module: "node16"`. So `tsc` emits CJS where `__dirname` works natively; both the `.js`-extension imports and the 149 extensionless imports resolve fine under Node CJS. No top-level await, no decorators, no JSON imports, no path aliases. Plain `tsc` is the right tool - no bundler needed.
- `pnpm check` (`tsc --noEmit`) already passes, so emit will succeed (same program, same diagnostics).
- `allowJs: true` covers `server/ago.js` / `server/bbcode.js` (imported by server code) - they get emitted to outDir too.
- Runtime disk reads that must resolve in the final image (all verified):
  - `./dist/rev-manifest.json` (cwd-relative, `server/index.ts:54`; missing manifest is non-fatal)
  - `join(__dirname, "..", "dist")` (`server/index.ts:95`) -> needs `dist/` as sibling of `server/`
  - `path.join(__dirname, "../../us-east-1-bundle.pem")` (`server/db/util.ts:10`) - **eager top-level readFileSync; boot crashes if missing**
  - `nunjucksRender("views", ...)` and `koaBetterStatic("public"/"dist")` - cwd-relative
- Server listens only after `cache3.waitUntilReady()` (DB queries) - full boot needs a reachable Postgres. `server/db/util.ts` disables SSL for `localhost`/`host.docker.internal`, so local Docker verification with a throwaway Postgres works.
- `import "dotenv/config"` tolerates a missing `.env`. Nothing reads package.json or repo files outside `server/` + the pem at runtime. `fly.toml` has no `[processes]`, so the image CMD applies.

## Changes

### 1. New `tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "build",
    "rootDir": ".",
    "sourceMap": true,
    "inlineSources": true
  }
}
```

- `rootDir: "."` because include spans `server/` and `tasks/` -> output lands at `build/server/index.js` (and `build/tasks/`, never copied to the image). outDir is auto-excluded by tsc.
- `inlineSources` so `--enable-source-maps` stack traces show code excerpts (the `.ts` sources aren't in the image).

### 2. `package.json`

- Add script: `"build:server": "tsc -p tsconfig.build.json"`.
- Move `tsx` from `dependencies` to `devDependencies` (no compiler in the prod image; dev/start scripts unchanged and still work locally since devDeps are installed).
- **Then run `pnpm install` to update `pnpm-lock.yaml`** - otherwise `--frozen-lockfile` fails in Docker.
- Leave `start`/`dev` scripts as-is (dev workflow untouched). Note: `pnpm start` won't work inside the prod container anymore (tsx pruned) - irrelevant, CMD is plain node.

### 3. Multi-stage `Dockerfile`

```dockerfile
FROM node:23-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build          # gulp assets -> dist/
RUN pnpm run build:server   # tsc -> build/
RUN pnpm prune --prod       # https://pnpm.io/cli/prune

FROM node:23-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/build/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/views ./views
COPY --from=build /app/public ./public
COPY --from=build /app/us-east-1-bundle.pem ./us-east-1-bundle.pem
EXPOSE 3000
CMD ["node", "--enable-source-maps", "server/index.js"]
```

- pnpm's node_modules symlinks are relative (`-> .pnpm/...`) and the path stays `/app`, so `COPY --from` preserves a working tree; `pnpm prune --prod` is already prod-proven in the current image. sharp ships prebuilt linuxmusl binaries; same base image in both stages.
- No corepack/pnpm in the runtime stage at all.

### 4. `.dockerignore` and `.gitignore`

Add `build` to both. Without this, a stale local `build/` from running `build:server` on the host leaks into `COPY . .` (tsc doesn't clean outDir - deleted modules' `.js` would survive into the image).

### 5. `fly.toml` and `fly.staging.toml`

- Both files: `grace_period = "20s"` -> `"10s"`; replace the stale "For some reason my start takes 12 seconds" comment with the new measured boot time. Only the health-check block (and its comments) is mirrored between the two files.
- `fly.toml` only: update the `auto_stop_machines` comment (currently claims "cold boot ~30s via tsx") - keep the setting `"off"` and `min_machines_running = 3` (the user's uncommitted mitigation stays).
- `fly.staging.toml`: leave its machine settings as they are - staging intentionally uses `auto_stop_machines = "stop"` and `min_machines_running = 0` so it can spin down. Do not copy prod's auto-stop settings there.

### 5b. CI workflow `.github/workflows/deploy.yml`

The `test` job's Build step currently runs `pnpm run build && pnpm prune --prod`, which never exercises the new server compilation - a broken `tsconfig.build.json` or emit error would only surface later during the Fly remote build. Change it to:

```yaml
run: pnpm run build && pnpm run build:server && pnpm prune --prod
```

(`build:server` must run before `pnpm prune --prod` since it needs the `typescript` devDependency.)

### 6. Remove debug logs

`server/s3.ts` lines 91, 93, 95, 102: the four `console.log("s3Url"...)` / `"guildUrl before"` / `"guildUrl after"` calls. Keep surrounding logic intact.

## Verification

1. `pnpm check` and `pnpm run build:server` locally; spot-check `build/server/index.js` exists and is CJS (`require(...)` calls), and `build/server/bbcode.js` made it.
2. `docker build -t guild:precompiled .`
3. Full boot timing with a throwaway DB:
   - `docker run -d --name guild-pg -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=guild -p 5433:5432 postgres:16-alpine`
   - Load schema from the host (dev path, uses tsx): `DATABASE_URL=postgres://postgres:secret@localhost:5433/guild NODE_ENV=development pnpm reset-db`
   - `docker run -d -p 3000:3000 -e PORT=3000 -e NODE_ENV=production -e DATABASE_URL=postgres://postgres:secret@host.docker.internal:5433/guild guild:precompiled`
   - Measure: timestamp loop curling `http://localhost:3000/health` until 200; report seconds from container start. **Target: < 5s.**
   - Fallback if schema load is flaky: measure container start -> "Waiting for cache3 to be ready" log line (proves all module loading is done; that's the part being fixed) and note the caveat.
4. Optional baseline: build the pre-change Dockerfile (`git stash` or from HEAD) as `guild:before` and measure the same way for the before/after delta.
5. Clean up throwaway containers.

## Constraints / wrap-up

- **Do NOT run `fly deploy`, do not push.** Note: `prod:deploy` script = version bump + `git push --follow-tags`, which likely triggers deploy - avoid any push.
- Commit everything including the pre-existing `fly.toml` mitigation (per user instruction), no version bump.
- Final report: measured boot time, and the deploy command for the user to run themselves: their usual `pnpm prod:deploy` (bumps version + pushes `[deploy]` tag), or directly `fly deploy --app rpguild`. Bluegreen strategy makes the rollout safe.

## Files touched

- `Dockerfile` (rewrite, multi-stage)
- `tsconfig.build.json` (new)
- `package.json` + `pnpm-lock.yaml` (script add, tsx -> devDeps)
- `.dockerignore`, `.gitignore` (add `build`)
- `fly.toml`, `fly.staging.toml` (grace_period, comments; staging keeps its own auto-stop settings)
- `.github/workflows/deploy.yml` (add `build:server` to the Build step)
- `server/s3.ts` (remove 4 debug logs)

## Out of scope (noted, not done)

- `node:23-alpine` is an EOL Node line - consider `node:24` LTS as a separate change.
- Pinning `"packageManager"` in package.json (removes corepack pnpm-version ambiguity) - optional follow-up; not bundled here to keep the deploy diff minimal.
- `prettier`, `react`, `react-dom` sit in `dependencies` but are never imported by server code - could be demoted later.

## Implementation notes

- Moved `server/index.ts`'s `join` import into the top Node import block after Docker smoke testing found the CommonJS emit could execute the asset fallback before the original late import initialized it.
- Kept `pnpm install`'s generated lockfile shape, which drops the stale `img-proxy` importer because `img-proxy/` is not listed in `pnpm-workspace.yaml`; Docker `pnpm install --frozen-lockfile` and `pnpm prune --prod` both pass with that shape.

## Follow Up

- `pnpm test` from the repo root runs `img-proxy/test/check-image-magic-bytes.test.ts` with cwd `/Users/dan/Code/guild`, so fixture reads like `test/img/example.jpg` fail; either exclude `img-proxy/` from the root Vitest run or make those tests resolve fixtures relative to `img-proxy/test/`.
- `pnpm reset-db` currently fails on a fresh Postgres database with `column "latest_post_id" of relation "forums" does not exist` during `server/reset_db.ts`, which prevents a local full `/health` Docker boot timing; repair the schema/reset path so a throwaway DB can reach `cache3.waitUntilReady()`.
- `img-proxy/package.json` is not included by `pnpm-workspace.yaml` and there is no `img-proxy/pnpm-lock.yaml`; decide whether `img-proxy/` should be a real workspace package or keep an independent lockfile.
