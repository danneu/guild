# Plan: Registration IP capture + staff-only display (profile page + JSON API)

## Context

Guild currently has **no durable record of the IP a user registered with**. IPs
are captured (`ctx.request.ip`, resolved in `server/index.ts:39` from the
Cloudflare `cf-connecting-ip` header) and stored per-action (`sessions`,
`posts`, `pms`, `hits`), but never on the `users` row. The signup IP only lives
implicitly on the first `sessions` row, which is deleted on logout
(`server/db/index.ts:1798`) and pruned on expiry -- so it is not reliable.

Goal: durably record each user's registration IP going forward, and let **staff
only** see it in two places:

1. The user profile page (`/users/:slug`), inside the existing "User Modkit"
   staff block.
2. A **new** staff-only JSON endpoint `GET /api/users/:userIdOrSlug` (no
   GET-user-as-JSON endpoint exists today).

Visibility is gated by the existing `READ_USER_IP` permission (down-chain
hierarchy) plus a hardcoded milestone date (**2026-07-04**): only show the IP
for users who registered on/after the milestone. Because the new column is only
ever populated for registrations after this change deploys, the milestone gate
is belt-and-suspenders / policy-explicit -- pre-existing users have
`registration_ip = NULL` and show nothing regardless.

## Decisions (already confirmed with user)

- **IP source:** new durable `users.registration_ip` column, populated at signup
  (not the ephemeral session row, not `hits`).
- **API scope:** the entire `GET /api/users/:slug` endpoint is staff-only
  (returns 404 to non-staff so it stays non-discoverable). The `registration_ip`
  field within it is further gated by the `READ_USER_IP` down-chain hierarchy.
- IP is staff-only on **both** surfaces.

## Changes

### 1. Schema: add the column

`registration_ip inet NULL` on `users`. Follow the repo's dual convention:

- **`sql/1-schema.sql`** -- add `registration_ip inet NULL` to the `users`
  `CREATE TABLE` (near `email_verified`, ~line 46). This is what fresh dev DBs
  get, since `reset_db.ts` runs `1-schema.sql`.
- **`sql/8-user-registration-ip.sql`** (new file) -- incremental migration for
  production, mirroring the `sql/7-uname-updated-at.sql` pattern:
  ```sql
  -- Durably record the IP each user registered from (staff-visible only).
  ALTER TABLE users ADD COLUMN registration_ip inet NULL;
  ```
  Note: `reset_db.ts` only auto-runs migrations 1-4; numbered migrations >=5 are
  applied to prod manually (via `pnpm run prod:ssh` + psql). This file must be
  applied by hand in prod as part of the rollout. **Do not deploy unless asked.**

### 2. Type

`server/dbtypes.ts` -- add `registration_ip: string | null;` to the `DbUser`
type (Postgres `inet` is returned as a string by node-postgres).

### 3. Capture at signup

`server/db/index.ts` -- `createUserWithSession` (the `INSERT INTO users` at
line 1754). Add the column + param; the value is already available as
`props.ipAddress` (passed from `ctx.request.ip` at
`server/routes/users.ts:266`):
```sql
INSERT INTO users (uname, digest, email, slug, hide_sigs, registration_ip)
VALUES ($1, $2, $3, $4, true, $5)
```
with `props.ipAddress` as `$5`. No route change needed -- `ipAddress` is already
threaded in.

### 4. Milestone constant

`server/config.ts` -- add near the other feature constants (e.g. `RULES_POST_ID`):
```ts
// Only surface registration IPs for users who registered on/after this date.
export const REGISTRATION_IP_MILESTONE = new Date("2026-07-04T00:00:00Z");
```

### 5. Shared gating helper (avoid drift between the two surfaces)

Add one pure helper, exported from **`server/cancan.ts`** (not the route file).
Rationale: `cancan.ts` already houses `READ_USER_IP`/`isStaffRole` and imports
only `config` + lightweight libs (no DB, no Koa), so the helper is import-safe
and unit-testable without a database; both the profile route and the API route
import it.
```ts
// server/cancan.ts
export function visibleRegistrationIp(currUser, user): string | null {
  if (!user.registration_ip) return null;
  if (user.created_at < config.REGISTRATION_IP_MILESTONE) return null;
  if (!can(currUser, "READ_USER_IP", user)) return null;
  return user.registration_ip;
}
```
Reuses the existing `READ_USER_IP` rule (`server/cancan.ts:468`, down-chain
hierarchy already used for the "Find Alt Accounts" link).

### 6. Profile page display

- `server/routes/users.ts` -- in the `GET /users/:userIdOrSlug` handler
  (renders at line 782), compute `registrationIp = cancan.visibleRegistrationIp(
  ctx.currUser, user)` and pass it into `ctx.render("show_user", { ... })`.
  Both `findUserBySlug` and `findUserWithRatingsBySlug` already `SELECT *`, so
  `user.registration_ip` is present with no query change.
- `views/show_user.html` -- inside the existing staff "User Modkit" block
  (`{% if ctx.currUser and cancan.isStaffRole(...) %}`, lines 152-178), next to
  the "Find Alt Accounts" link (line 173), add:
  ```html
  {% if registrationIp %}
    <li>Registration IP: <code>{{ registrationIp }}</code></li>
  {% endif %}
  ```
  Gating is done in the route, so the template just checks presence.

### 7. New staff-only JSON endpoint

`server/routes/users.ts` -- add `router.get("/api/users/:userIdOrSlug", ...)`:
- **Auth:** `ctx.assert(ctx.currUser && cancan.isStaffRole(ctx.currUser.role), 404);`
  (404, not 403, so the endpoint is invisible to members).
- **Resolve the param exactly like the profile route** (`GET
  /users/:userIdOrSlug`, lines 678-706), so numeric IDs work -- not slug-only:
  for an all-digit param, try `db.findUserBySlug` first (legacy all-digit
  usernames), then fall back to `db.findUser` (by id, = `findUserById`, confirmed
  at `server/db/index.ts:4692`); otherwise `db.findUserBySlug`. Then
  `ctx.assert(user, 404)`. (No HTTP redirect for the API -- just resolve.)
- **Serialize via a pure, explicit whitelist**, NOT the raw/presented row.
  `presentUser` deletes `digest` but still exposes `email` and other internal
  fields (`eflags`, etc.), so dumping it would leak PII. Extract this shaping
  into a pure, unit-testable function in **`server/presenters.ts`** (next to
  `presentUser`), so the whitelist is covered by a test rather than a manual
  check:
  ```ts
  // server/presenters.ts
  export function presentUserForApi(user, viewer) {
    return {
      id: user.id, uname: user.uname, slug: user.slug, role: user.role,
      url: "/users/" + user.slug,
      created_at: user.created_at, last_online_at: user.last_online_at,
      avatar_url: user.avatar_url, custom_title: user.custom_title,
      posts_count: user.posts_count, is_nuked: user.is_nuked,
      registration_ip: cancan.visibleRegistrationIp(viewer, user), // string | null
    };
  }
  ```
  The route sets `ctx.body = pre.presentUserForApi(user, ctx.currUser)` (Koa
  emits JSON for an object body; match the existing `ctx.type = "json"` style if
  needed). Note: `presenters.ts` importing `cancan.ts` -- verify no import cycle
  at implementation time; if one appears, pass the computed IP in as an argument
  instead of importing `cancan` into `presenters`.
- Confirm no route-ordering collision: existing `PUT /api/users/:id/bio`
  (`server/routes/users.ts:422`) is a different method; this GET is new.

## Files touched

- `sql/1-schema.sql` (add column to `users`)
- `sql/8-user-registration-ip.sql` (new migration)
- `server/dbtypes.ts` (`DbUser.registration_ip`)
- `server/db/index.ts` (INSERT in `createUserWithSession`, ~line 1754)
- `server/config.ts` (`REGISTRATION_IP_MILESTONE`)
- `server/cancan.ts` (`visibleRegistrationIp` helper)
- `server/presenters.ts` (`presentUserForApi` whitelist serializer)
- `server/routes/users.ts` (profile route pass-through + new API route)
- `views/show_user.html` (staff modkit `<li>`)
- `server/cancan.test.ts` (new) and `server/presenters.test.ts` (new) -- see Tests

## Tests

The security-critical logic is deliberately extracted into two pure functions so
it is covered by structure-insensitive unit tests (matching the repo's
`policy.test.ts` pure-function style), with no DB or Koa harness (none exists for
routes). Build small fixture user objects inline.

- **`server/cancan.test.ts`** (new) -- `visibleRegistrationIp(viewer, target)`:
  - Milestone boundary: `created_at` before / exactly at / after
    `2026-07-04` (returns null before, value on/after) -- with an admin viewer
    and non-null IP so only the date varies.
  - Down-chain `READ_USER_IP` hierarchy: admin sees all; smod sees
    mod/member/banned; mod sees member/banned; member and self see null.
  - `registration_ip` null -> null regardless of viewer/date.
- **`server/presenters.test.ts`** (new) -- `presentUserForApi(user, viewer)`:
  - Asserts the result **omits `email` and `digest`** (the PII-leak guard) and
    other non-whitelisted fields (`eflags`).
  - `registration_ip` present for a staff viewer past the milestone; `null` for
    a member viewer or a pre-milestone user.

Signup capture (`createUserWithSession` writes `props.ipAddress` into the users
INSERT): cover with a mock-pg-client test in the `server/db/convos.test.ts`
style (assert the users INSERT call's params include the ip) **only if
`server/db/index.ts` imports without side effects** in the test env; that module
initializes the pool on import, so if importing it requires a live DB, cover
signup capture via the manual verification step (step 3 below) instead and note
that in the test file. The one-line INSERT param addition is also guarded by
`tsc` and the existing `assert(_.isString(props.ipAddress))` at
`server/db/index.ts:1723`.

The API's staff-only 404 for non-staff is thin glue reusing the existing
`cancan.isStaffRole` gate; a full route test would need a Koa harness the repo
lacks, so it is covered by the verification steps rather than a new test.

## Verification

1. `pnpm run check` (tsc) and `pnpm test` -- must pass, including the new
   `cancan.test.ts` / `presenters.test.ts` suites.
2. `pnpm run prettier` on touched `server/**/*.ts`.
3. Dev DB: `pnpm run reset-db`, then register a new user via `/register`.
   Confirm the row is populated: `SELECT uname, registration_ip FROM users
   ORDER BY id DESC LIMIT 1;` (should be the dev IP, e.g. `127.0.0.1`).
4. Profile page, logged in as a **staff** account (dev seed user id 1 is
   admin): visit `/users/<newuser>` -> "Registration IP" line appears in the
   modkit block. Logged in as a **member** (or logged out): line is absent.
5. API:
   - As staff (with session cookie): `GET /api/users/<newuser>` -> JSON includes
     `registration_ip`. Verify the response does **not** contain `email` or
     `digest`.
   - As a member: `GET /api/users/<newuser>` -> 404.
   - By numeric id: `GET /api/users/<numericId>` resolves the same record (not a
     404), confirming the id-or-slug fallback.
   - Staff hitting a target above their chain (e.g. mod -> admin): record
     returns but `registration_ip` is `null`.
6. Milestone: an old user (`created_at` < 2026-07-04, `registration_ip` NULL)
   shows nothing on either surface.

## Out of scope / notes

- No backfill of registration IPs for existing users (data doesn't durably
  exist). The dormant `hits`-based alt-detection (`/users/:slug/alts`, currently
  disabled) is untouched.
- Applying `sql/8-*.sql` to production is a manual deploy step; not done here.

## Implementation notes

- Skipped the optional `createUserWithSession` mock-pg unit test because
  importing `server/db/index.ts` initializes the pg pool and patches pg
  prototypes; signup capture is covered by the direct INSERT change, existing
  `props.ipAddress` assertion, `tsc`, and the plan's manual DB verification.
