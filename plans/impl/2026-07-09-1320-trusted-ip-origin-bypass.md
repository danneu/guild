# Plan: Trusted client-IP resolution, origin-bypass rejection, staff IP annotation

## Context

Commit 743f42d started storing `users.registration_ip` for staff review. Two
problems surfaced:

1. **The IP capture is spoofable.** `server/index.ts:40-43` (the first
   `app.use`) does `ctx.request.ip = ctx.get("cf-connecting-ip") || ctx.ip`,
   blindly trusting the header. The Fly origin is publicly reachable at
   `rpguild.fly.dev` (verified: returns 200, bypassing Cloudflare), so
   `curl -H "CF-Connecting-IP: 8.8.8.8" https://rpguild.fly.dev/register ...`
   forges any IP into `registration_ip`, `sessions`, `posts`, `pms`,
   `ratelimits`, and `viewers`. A second raw read of the header exists at
   `server/middleware/cloudflare-turnstile.ts:27`.
2. **Shared Cloudflare egress IPs confuse staff.** The observed
   `104.28.203.54` is NOT a Cloudflare proxy address -- it is a Cloudflare
   WARP egress IP (in CF's geofeed `api.cloudflare.com/local-ip-ranges.csv`,
   geolocated Seattle; not in the published proxy ranges; not in Apple's
   Private Relay list). WARP / iCloud Private Relay users always record such
   shared VPN exit IPs. That is correct capture -- the real IP is
   unrecoverable -- but staff need an annotation so they don't treat it as
   unique-per-user or ban it.

Topology and header facts (researched, verified 2026-07-09):

- Prod: client -> Cloudflare (www.roleplayerguild.com) -> Fly proxy (app
  `rpguild`) -> app. Staging (`rpguild-staging`) is accessed **directly** at
  rpguild-staging.fly.dev with no Cloudflare, and `fly.staging.toml` also sets
  `NODE_ENV=production` -- so NODE_ENV cannot distinguish prod from staging.
- `fly-client-ip` is always set by Fly's proxy to the actual TCP peer that
  connected to Fly's edge (a CF edge IP when routed through Cloudflare; the
  real client on a direct hit). It is **absent** on Fly health checks -- the
  local Fly agent hits `GET /health` (server/index.ts:396-399) directly.
- `cf-connecting-ip` is authoritative only when the peer is Cloudflare.
- `x-forwarded-for` is client-prependable; ignore it. `app.proxy` is never
  set (the TODO at server/index.ts:207-209 is stale) and must stay false.
- Koa mechanics: assigning `ctx.request.ip` shadows the getter and `ctx.ip`
  delegates to it, so every downstream reader sees the resolved value. The IP
  middleware is the first `app.use`; nothing reads IPs before it.

## Decisions (confirmed with user)

- Origin-bypass rejection responds **403** with a short plain-text body.
- The staff JSON API (`GET /api/users/:userIdOrSlug`) **does** get a
  `registration_ip_note: string | null` field alongside `registration_ip`.
- Detection scope is Cloudflare egress only (no Apple/Akamai/Fastly Private
  Relay lists), **but the range lists must update automatically** -- no
  frozen hardcoded list. Hardcoded defaults act as boot values and
  keep-on-failure fallback; an in-module background job (started after
  `app.listen`, NOT a cache3 entry -- see section 2) refreshes from
  Cloudflare's published endpoints and replaces the sets on success.

## Changes

### 1. New module: `server/cloudflare_ip.ts`

Zero-dependency; imports nothing from the app (keeps it pure and cycle-free --
`presenters.ts`, `routes/users.ts`, and `index.ts` will import it).

**Matching mechanism:** sorted, merged integer intervals with binary search --
NOT `net.BlockList`. Reasons: the egress list refreshed from the geofeed is
~138k mostly-/32 CIDRs that merge down to a few thousand dense intervals
(BlockList would hold all 138k rules, O(n) native scan, ~tens of MB on 512MB
VMs); and the matcher must be rebuilt atomically on refresh. IPv4 -> uint32,
IPv6 -> BigInt of the full 128 bits. Plus a small interval-subtraction helper
(used by both setters to derive effective egress as raw geofeed minus current
proxy space -- see the setter API below). ~70 lines, fully unit-testable.

Hardcoded defaults (fallback + boot values), with source URLs in comments:

```ts
// Source: https://www.cloudflare.com/ips-v4 + /ips-v6 (2026-07-09).
// Boot values; replaced at runtime by the refresh job (section 2). Exported
// for tests (afterEach restore).
export const DEFAULT_PROXY_CIDRS = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
// Shared WARP / iCloud Private Relay exit supernets, derived from
// https://api.cloudflare.com/local-ip-ranges.csv (2026-07-09). Boot values;
// replaced at runtime from the same geofeed by the refresh job.
export const DEFAULT_EGRESS_CIDRS = ["104.28.0.0/14", "2a09:bac0::/29", "2606:54c0::/28"];
```

Exported API (top-level `function` declarations, `type` not `interface`):

- `normalizeIp(raw: string | null | undefined): string | null` -- trim,
  unwrap IPv4-mapped IPv6 (`::ffff:1.2.3.4` -> `1.2.3.4`), validate with
  `net.isIP`, return null on garbage. Never throws.
- `isCloudflareProxyIp(ip: string): boolean` / `isCloudflareEgressIp(ip: string): boolean`
  -- check against the current (mutable, module-level) interval sets.
- `resolveClientIp({ flyClientIp, cfConnectingIp, socketIp }): string` --
  `peer = normalizeIp(flyClientIp) ?? normalizeIp(socketIp) ?? socketIp`;
  return `cfConnectingIp` (normalized) only if present AND
  `isCloudflareProxyIp(peer)`; else return `peer`. Never throws.
- `ipStaffNote(ip: string | null | undefined): string | null` -- **proxy
  match checked FIRST** -> "Cloudflare proxy IP -- likely recorded before
  trusted IP resolution shipped, not a real client address"; else egress
  match -> "Cloudflare WARP / iCloud Private Relay egress -- shared VPN exit
  used by many users, not unique to this account"; else null. Proxy-first
  ordering matters: the geofeed mixes proxy-edge rows into the egress source
  (1,424 proxy-space rows today, e.g. `103.22.200.0/24`), so egress-first
  would mislabel proxy IPs as WARP exits after a refresh. The effective egress
  set derived by both setters below (`rawEgressIntervals - proxyIntervals`) is
  disjoint from proxy space anyway; the ordering is defense in depth. Document
  both on the function.
- `setProxyRanges(cidrs: string[]): void` / `setEgressRanges(cidrs: string[]): void`
  -- **replace** the corresponding interval set (no union with defaults:
  Cloudflare's live endpoints are authoritative, and unioning forever would
  keep trusting `cf-connecting-ip` from ranges Cloudflare has given up --
  a stale spoofing path). Defaults are installed at module load; a failed or
  rejected refresh keeps the current set (see section 2).

  The module keeps **three** interval sets so the disjoint invariant survives
  a partial refresh (one step succeeds, the other fails -- see section 2) in
  **either** direction, including a shrinking proxy list:
  - `proxyIntervals` -- the current proxy set (what `isCloudflareProxyIp`
    reads).
  - `rawEgressIntervals` -- the last raw geofeed, **unfiltered**. Never read
    directly by a predicate; retained only as the derivation source.
  - `egressIntervals` -- the effective egress set (what `isCloudflareEgressIp`
    reads), always `rawEgressIntervals - proxyIntervals`.

  Both setters install their parsed input and then **recompute
  `egressIntervals = rawEgressIntervals - proxyIntervals`** from the retained
  raw geofeed (interval subtraction), so effective egress is a pure function
  of the two most recent successful fetches regardless of order:
  - `setEgressRanges(cidrs)` sets `rawEgressIntervals` from its input, then
    recomputes.
  - `setProxyRanges(cidrs)` sets `proxyIntervals` from its input, then
    recomputes.

  Recomputing from the **raw** geofeed (not from the already-filtered
  `egressIntervals`) is what makes shrink safe: if Cloudflare moves a range
  out of proxy space and the subsequent geofeed fetch fails, the range is
  restored to effective egress because it still lives in `rawEgressIntervals`.
  Subtracting a smaller proxy set from the previously-filtered egress set could
  not restore it -- those rows were already gone. Conversely, when proxy grows
  and geofeed fails, the newly-proxied range drops out of effective egress, so
  exported `isCloudflareEgressIp` never reports true for an address that is now
  a proxy IP. (`ipStaffNote` is separately protected by proxy-first ordering;
  the exported egress predicate is not, hence this derivation.)

  Both setters throw on invalid CIDRs -- the caller catches and keeps the
  previous sets. Two separate setters so a geofeed failure cannot undo a
  successful proxy update and vice versa.
- `shouldRejectOriginBypass({ enabled, path, flyClientIp }): boolean` -- pure
  decision function behind the 403 middleware (3b): false when `!enabled`,
  when `path === "/health"`, when `flyClientIp` is empty (Fly health checks
  bypass the proxy), or when `isCloudflareProxyIp(flyClientIp)`; true
  otherwise. Exists so the rejection behavior has unit-test regression
  coverage, not just the curl matrix.
- Pure parsers for the refresh job, unit-testable with fixture strings:
  - `parseProxyIpLists(v4Text: string, v6Text: string): string[]` -- one CIDR
    per line per body, validated **jointly**: throw on any invalid line,
    < 10 v4 entries, < 3 v6 entries, or missing the v4 anchor
    `104.16.0.0/13`. (Joint validation because ips-v6 alone has ~7 entries
    and no v4 anchor -- per-body checks against those thresholds would
    always fail for v6.)
  - `parseGeofeedCidrs(csv: string): string[]` -- first CSV column per line,
    skipping blanks/`#` comments/malformed rows; throw if < 10,000 valid
    rows (~138k today; guards truncated/HTML bodies).

### 2. Automatic range refresh: in-module job, started after `app.listen`

Also in `server/cloudflare_ip.ts` -- NOT a cache3 entry (rationale below):

- `refreshCloudflareIpRanges(fetchImpl: typeof fetch = fetch): Promise<void>`
  -- two internally try/caught steps:
  1. Fetch `https://www.cloudflare.com/ips-v4` + `/ips-v6` (each
     `AbortSignal.timeout(10_000)`, check `res.ok`), `parseProxyIpLists`,
     `setProxyRanges`. Log a one-line diff summary (CIDRs added/removed vs
     the previous set) so proxy-range drift is visible in prod logs.
  2. Fetch `https://api.cloudflare.com/local-ip-ranges.csv` (~12MB,
     `AbortSignal.timeout(60_000)` -- no boot budget to honor anymore),
     `parseGeofeedCidrs`, `setEgressRanges`, log row/interval counts.

  A failed step logs `console.error` and keeps the current set; step 2 still
  runs if step 1 fails. Never throws to the caller. (`fetchImpl` parameter
  exists purely for tests.)
- `startCloudflareIpRangeRefresh(): void` -- idempotent (guard boolean);
  kicks off `refreshCloudflareIpRanges().catch(console.error)` immediately,
  then `setInterval(..., 1000 * 60 * 60 * 12).unref()` (unref so scripts and
  tests never hang on the timer). Module import performs no I/O; only
  `index.ts` calls the starter (see 3e), and tests never import `index.ts`.

**Why not cache3 (boot-safety, verified against the engine):** `app.listen`
sits inside `cache3.waitUntilReady().then(...)` (server/index.ts:2877-2881)
with a 10s timeout and **no `.catch`**. The engine's `updateLoop`
(server/cache3/index.ts:212-243) awaits every enabled key's fetch
**sequentially** in one pass, the first pass fires ~1s after `start()`
(`loopInterval` default 1000ms), and readiness requires ALL enabled keys to
complete a first fetch. Inserting a network fetch with a multi-second worst
case into that sequential pass can push the first pass past 10s ->
`CacheTimeoutError` -> unhandled rejection -> the app never listens and the
bluegreen deploy wedges. Running the refresh outside cache3, strictly after
listen, makes boot-safety structural rather than a "this fetch must be fast
and never throw" convention -- and cache3 buys nothing here anyway: the live
state is the module-level matchers mutated via the setters, not a cached
value anything reads with `get()`.

### 3. `server/index.ts`

**3a. Replace the IP middleware (lines 39-43):**

```ts
app.use((ctx: Context, next: Next) => {
  if (config.NODE_ENV === "development" && ctx.get("cf-connecting-ip")) {
    // Local-dev escape hatch: fake an IP for testing, e.g.
    //   curl -H "CF-Connecting-IP: 6.6.6.6" localhost:3000/register
    // Unreachable on Fly: both fly.toml and fly.staging.toml pin
    // NODE_ENV=production.
    ctx.request.ip = ctx.get("cf-connecting-ip");
    return next();
  }
  ctx.request.ip = resolveClientIp({
    flyClientIp: ctx.get("fly-client-ip"),
    cfConnectingIp: ctx.get("cf-connecting-ip"),
    socketIp: ctx.ip,
  });
  return next();
});
```

The dev hatch preserves the current local testing workflow (cf. the
commented-out ip-override hack at routes/users.ts:347) while keeping
`resolveClientIp` an honest model of production trust.

**3b. Origin-bypass rejection, immediately after 3a** (before static assets):

```ts
app.use((ctx: Context, next: Next) => {
  const reject = shouldRejectOriginBypass({
    enabled: config.REJECT_ORIGIN_BYPASS,
    path: ctx.path,
    flyClientIp: ctx.get("fly-client-ip"),
  });
  if (!reject) return next();
  ctx.status = 403;
  ctx.body = "Direct origin access is not allowed. Use https://www.roleplayerguild.com";
});
```

The middleware is a thin shell; the decision logic lives in the pure,
unit-tested `shouldRejectOriginBypass` (section 1).

**3c.** Delete the stale TODO at lines 207-209 (it claims `app.proxy === true`;
it never was, and the reject work is now done). Do NOT set `app.proxy = true`.

**3d.** Remove `"rpguild.fly.dev"` from the `protectCsrf` whitelist (lines
170-177); keep `"rpguild-staging.fly.dev"`. With rejection live, no legitimate
page is served from that origin.

**3e.** Start the refresh **inside the `app.listen` callback** (lines
2877-2881), on the line right after `console.log("Listening on", config.PORT)`:

```ts
cache3.waitUntilReady().then(() => {
  app.listen(config.PORT, () => {
    console.log("Listening on", config.PORT);
    startCloudflareIpRangeRefresh();
  });
});
```

Placing the call in the listen callback (not merely after the `app.listen(...)`
statement) guarantees the socket is already listening before the refresh fires,
so `"Listening on"` always precedes the refresh log lines -- which is exactly
what the boot-order verification (section Verification, step 2) asserts. The
refresh must never run before listen (section 2).

### 4. `server/config.ts`

Next to the other `=== "true"` flags (~line 167 pattern):

```ts
// Reject requests that bypass Cloudflare and hit the Fly origin directly
// (rpguild.fly.dev). Prod fly.toml only -- staging is direct-access by design.
export const REJECT_ORIGIN_BYPASS = process.env.REJECT_ORIGIN_BYPASS === "true";
console.log("Reject origin bypass:", REJECT_ORIGIN_BYPASS);
```

### 5. `server/middleware/cloudflare-turnstile.ts:27`

`const ip = ctx.request.ip;` -- the resolution middleware runs first, so
Turnstile's `remoteip` gets the trusted value instead of the raw header.

### 6. `fly.toml` (NOT fly.staging.toml)

```toml
# Reject requests that bypass Cloudflare and hit rpguild.fly.dev directly.
# Deliberately absent from fly.staging.toml (staging is accessed directly).
REJECT_ORIGIN_BYPASS = "true"
```

### 7. Staff annotation wiring

- `server/routes/users.ts` (~line 803, show_user handler):
  `const registrationIpNote = ipStaffNote(registrationIp);` -- derived from
  the already-gated `visibleRegistrationIp` output so visibility gating is
  inherited (the note can never leak when the IP is hidden). Pass
  `registrationIpNote` into `ctx.render("show_user", ...)`.
- `views/show_user.html` (modkit block, ~line 176):

```html
{% if registrationIp %}
  <li>
    Registration IP: <code>{{ registrationIp }}</code>
    {% if registrationIpNote %}
      <br><span class="text-muted">{{ registrationIpNote }}</span>
    {% endif %}
  </li>
{% endif %}
```

- `server/presenters.ts` `presentUserForApi`: hoist
  `const registrationIp = cancan.visibleRegistrationIp(viewer, user);` and
  return `registration_ip: registrationIp, registration_ip_note: ipStaffNote(registrationIp)`.

Annotation is computed at render time from the stored string, so existing rows
(including 104.28.203.54) are annotated retroactively -- no backfill.

## Files touched

- `server/cloudflare_ip.ts` (new; matchers, resolver, notes, parsers, refresh
  job) + `server/cloudflare_ip.test.ts` (new)
- `server/index.ts` (middlewares, TODO removal, CSRF list, refresh starter)
- `server/config.ts` (`REJECT_ORIGIN_BYPASS`)
- `server/middleware/cloudflare-turnstile.ts` (trusted IP read)
- `server/routes/users.ts`, `views/show_user.html`, `server/presenters.ts`,
  `server/presenters.test.ts` (annotation)
- `fly.toml` (env flag)

## Tests

`server/cloudflare_ip.test.ts` (vitest, pure-function style of
`cancan.test.ts`; no Koa harness -- both middlewares are thin shells over the
unit-tested `resolveClientIp` / `shouldRejectOriginBypass`, and the shells
themselves are exercised by the curl matrix):

- **Interval matcher / membership:** representative proxy IPs match
  (`104.16.0.1`, `172.71.10.5`, `162.158.1.1`, `2400:cb00::1`,
  `2606:4700:4700::1111`, mapped `::ffff:104.16.0.1`); non-CF IPs don't
  (`8.8.8.8`, `127.0.0.1`, `::1`, `fdaa:0:1::2`); **critically,
  `104.28.203.54` is NOT a proxy IP but IS an egress IP** (the lists are
  disjoint where it matters); egress boundaries `104.28.0.0` /
  `104.31.255.255` in, `104.27.255.255` / `104.32.0.0` out; v6 egress
  `2a09:bac0::1`, `2606:54c0::1` in. Garbage (`""`, `"banana"`,
  `"999.1.1.1"`) is false, never throws.
- **`resolveClientIp`:** through-CF happy path (peer=CF edge, cf header ->
  returned); direct-hit spoof ignored (peer `198.51.100.7` + forged cf header
  -> peer returned); no headers -> socket IP; WARP case (peer=CF edge, cf
  header `104.28.203.54` -> passed through faithfully); IPv6 end-to-end;
  mapped-IPv4 socket normalized to dotted quad; garbage fly-client-ip falls
  back to socket; garbage cf header ignored; never throws on any combination.
- **`ipStaffNote`:** egress IP -> shared-VPN note (assert stable substring,
  e.g. `/not unique/`); proxy IP -> pre-fix note; ordinary IP / null /
  garbage -> null. Proxy-precedence: after `setEgressRanges` with an input
  that includes a proxy-space CIDR (simulating an unfiltered geofeed),
  `ipStaffNote` on a proxy IP still returns the proxy note.
- **`shouldRejectOriginBypass`:** false when `enabled: false` (whatever the
  peer); false for `path: "/health"`; false for empty `flyClientIp` (Fly
  health check shape); false for a CF proxy peer (`104.16.0.1`); **true**
  for a non-CF peer (`8.8.8.8`) with the flag on and a non-health path;
  garbage `flyClientIp` -> true (unknown peer is not Cloudflare).
- **Parsers:** `parseProxyIpLists` round-trips fixtures of the real ips-v4 +
  ips-v6 bodies; throws on an HTML body, an invalid line, too few v4 or v6
  entries, or a missing `104.16.0.0/13` anchor; `parseGeofeedCidrs` parses
  fixture rows in the real live shape (mostly `/32` rows, including
  `104.28.203.54/32`; skipping a blank line, a `#` comment, and a malformed
  row), throws under 10k rows.
- **Setters (replace + subtraction semantics):** after
  `setProxyRanges(["198.51.100.0/24"])`, `isCloudflareProxyIp` matches
  `198.51.100.5` and NO LONGER matches default `104.16.0.1` (replace, not
  union), and `resolveClientIp` trust follows the new set;
  `setEgressRanges` with a fixture containing one proxy-space row
  (`103.22.200.0/24` -- a real geofeed row) and one egress row
  (`104.28.203.54/32` -- the motivating address in its real live shape: the
  geofeed publishes it as a `/32`, not a `/24`): the proxy row is subtracted
  (`isCloudflareEgressIp("103.22.200.5")` false) while the egress row matches
  exactly (`isCloudflareEgressIp("104.28.203.54")` true). Restore defaults in
  `afterEach` via the exported `DEFAULT_*` constants.
- **Setter disjointness under partial refresh -- proxy GROWS:** install an
  egress set via `setEgressRanges(["104.28.0.0/14"])` (so
  `isCloudflareEgressIp("104.28.203.54")` true), then call
  `setProxyRanges(["104.28.203.0/24"])` simulating Cloudflare newly proxifying
  that range with NO subsequent geofeed refresh. Assert
  `isCloudflareEgressIp("104.28.203.54")` is now **false** (effective egress
  re-derived as raw geofeed minus the grown proxy set) while
  `isCloudflareProxyIp("104.28.203.54")` is true.
- **Setter disjointness under partial refresh -- proxy SHRINKS (regression for
  the raw-geofeed retention):** self-contained setup --
  `setEgressRanges(["104.28.0.0/14"])` then `setProxyRanges(["104.28.203.0/24"])`,
  establishing raw geofeed `104.28.0.0/14`, proxy `104.28.203.0/24`, and
  effective egress that excludes `104.28.203.54` (assert false). Then call
  `setProxyRanges(["198.51.100.0/24"])` -- Cloudflare pulls `104.28.203.0/24`
  back out of proxy space, with NO geofeed refresh. Assert
  `isCloudflareEgressIp("104.28.203.54")` is **true again** and
  `isCloudflareProxyIp("104.28.203.54")` false. This fails if egress is
  re-derived from the already-filtered set instead of `rawEgressIntervals`,
  because the row would have been permanently subtracted out.
- **`refreshCloudflareIpRanges`:** with a stub `fetchImpl` returning
  `new Response(...)` bodies: (a) valid payloads replace both sets; (b) a
  rejecting geofeed fetch still applies the proxy update, resolves without
  throwing, **and leaves the two sets disjoint** -- a proxy CIDR from the
  successful step is not reported by `isCloudflareEgressIp` even though the
  egress set was never refreshed (proxy-update-then-geofeed-failure ordering);
  (c) a truncated/below-floor proxy body leaves the proxy set unchanged
  (parse throws, caught, previous kept).

`server/presenters.test.ts`: extend the strict `toEqual` whitelist with
`registration_ip_note: null` (mandatory -- the existing test uses `toEqual`
and will fail otherwise); new cases: egress IP + admin viewer -> note string;
member viewer -> ip and note both null; pre-milestone user -> both null.

## Verification

1. `pnpm run check` && `pnpm test` && `pnpm run prettier` on touched files.
2. Local curl matrix, prod-mode
   (`NODE_ENV=production REJECT_ORIGIN_BYPASS=true pnpm start`, local PG):
   - `curl -i localhost:3000/health` -> 200 (no fly-client-ip).
   - `curl -i -H "Fly-Client-IP: 8.8.8.8" localhost:3000/` -> 403.
   - `curl -i -H "Fly-Client-IP: 8.8.8.8" -H "CF-Connecting-IP: 1.2.3.4" localhost:3000/` -> 403 (forged header doesn't help).
   - `curl -i -H "Fly-Client-IP: 104.16.0.1" localhost:3000/` -> 200 (simulated via-CF).
   - IP capture proof: with `Fly-Client-IP: 104.16.0.1` + `CF-Connecting-IP: 203.0.113.9`,
     register a user; `SELECT uname, registration_ip FROM users ORDER BY id DESC LIMIT 1`
     -> `203.0.113.9`. Repeat with `Fly-Client-IP: 8.8.8.8` (flag off) ->
     records `8.8.8.8`, spoof ignored.
   - Boot order: the "Listening on <port>" line appears BEFORE the
     range-refresh summary lines; with network cut, the app still listens
     and only logs refresh errors (defaults stay in effect) -- boot can
     never block on Cloudflare.
3. Dev mode (`pnpm run dev`): `curl -H "CF-Connecting-IP: 6.6.6.6" ...` still
   fakes the IP (dev hatch); plain requests record `127.0.0.1`/`::1`.
4. Annotation: seed/register a user, `UPDATE users SET registration_ip = '104.28.203.54' WHERE ...`;
   staff view of the profile shows the muted WARP note;
   `GET /api/users/<slug>` as staff shows `registration_ip_note`; as member -> 404.

## Rollout

- One normal prod deploy carries code + `REJECT_ORIGIN_BYPASS=true` together
  (fly.toml is read at deploy). Health checks are exempt twice over, so
  bluegreen cannot wedge. Deploy staging first (flag unset there; verifies
  resolution + annotation on a direct-access app).
- Post-deploy checks: `curl -i https://rpguild.fly.dev/` -> 403;
  `curl -i https://www.roleplayerguild.com/` -> 200;
  `curl -i https://rpguild-staging.fly.dev/` -> 200;
  `fly checks list --app rpguild` green; boot logs show
  "Reject origin bypass: true" and the range-refresh summary.
- Rollback lever: set `REJECT_ORIGIN_BYPASS = "false"` in fly.toml and
  redeploy. The IP-resolution change itself needs no flag -- it is strictly
  safer than the old behavior in every environment.

## Risks / notes

- **Proxy-range drift** would 403 users routed through new CF edges.
  Mitigated by the 12h auto-refresh and the flag rollback. Refresh
  **replaces** the proxy set on success rather than unioning with defaults:
  a permanent union would keep trusting `cf-connecting-ip` from ranges
  Cloudflare has relinquished -- a stale spoofing path. The availability
  risk of a bad live payload is guarded instead by validation (joint parse,
  throw on any invalid line, per-family entry floors, the `104.16.0.0/13`
  anchor, `res.ok`), keep-previous-on-failure, and the logged diff summary
  on every change.
- **A syntactically-valid-but-wrong proxy list** (e.g. a drastically
  shrunken one that still passes the floors and anchor) could 403 some
  legitimate traffic within 12h fleet-wide. Accepted: the published proxy
  list has been stable for years, the diff log makes it visible, and the
  flag-off rollback is one deploy.
- **Pre-fix spoofed data is only partially detectable**: proxy-range values
  get the "likely not a real client" note, but a pre-fix forged `8.8.8.8` is
  indistinguishable from real data. Exposure is bounded by the 2026-07-04
  milestone.
- `app.proxy` stays false, so `ctx.protocol` still says "http" in prod --
  pre-existing, deliberate (enabling it would trust forgeable
  `x-forwarded-for`). Noted so nobody "fixes" it later.
- Egress coverage is best-effort even with refresh (long tail of small
  acquired CF blocks; Private Relay's Akamai/Fastly exits out of scope by
  decision). False negatives just mean no note; false positives are
  effectively impossible.
- WARP users' real IPs are unrecoverable by design (Cloudflare replaces the
  client IP for everyone since ~2022) -- the 104.28.203.54 row is correct
  data, now correctly labeled.

## Implementation notes

- Intervals are stored as `bigint` for BOTH families (the plan suggested
  uint32 for v4), kept in per-family arrays so families never cross-match.
  Uniform bigint keeps the shared `subtractIntervals` / binary-search helpers
  simple with no correctness cost -- v4 values just live in 0..2^32-1.
- The origin-bypass middleware ends with an explicit `return;` on the reject
  path to satisfy `noImplicitReturns` (the other branch returns `next()`).
- `refreshCloudflareIpRanges` keeps a small module-level `lastProxyCidrs` for
  its proxy-diff log. It is intentionally decoupled from `setProxyRanges` (the
  setter stays pure to intervals), so a manual setter call in tests does not
  perturb the diff baseline -- only a successful refresh advances it.
