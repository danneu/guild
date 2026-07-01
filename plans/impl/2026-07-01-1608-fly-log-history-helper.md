# Plan: `scripts/fly-logs.sh` — historical Fly log fetcher

## Context

`fly logs` (and the `prod:logs` / `staging:logs` npm scripts) only **live-tail** Fly's
NATS stream — you can't look backwards, so a ~1-hour buffer is all you ever see. This
bit us today: a casino-spam Introduction post bypassed the Claude antispam classifier
"around 7am" and by the time we looked, `fly logs` had nothing.

It turns out Fly **does** retain ~7 days of logs, reachable via an HTTP Logs API that
the CLI doesn't expose. Using it, the 7am incident was recovered in seconds — the first
antispam line of the window was:

```
12:08:22 UTC (7:08am CDT)  antispam process: { action: 'ALLOW', result: { ok: false, error: 'API_TIMEOUT' } }
```

i.e. the classifier call hit its 10s timeout and **failed open** (`policy.ts:16`,
`if (!r.ok) return "ALLOW"`). That root-cause fix (timeout/retry behavior) is a
**separate task** and out of scope here.

This plan adds a small, tracked helper so future "what happened at 7am" spelunking is one
command instead of a hand-rolled curl + cursor-pagination loop. Deliverable: a bash script
`scripts/fly-logs.sh` plus a `prod:logs:history` npm script.

## Decisions (confirmed with user)

- **Language:** Bash (`scripts/fly-logs.sh`). First `.sh` in the repo; the existing
  `scripts/antispam-probe.ts` is tsx, but user chose bash for this ops helper.
- **Auth:** default to `fly auth token -q` (piggybacks on the login already used by
  `prod:logs` / `prod:ssh`; that subcommand is now marked DEPRECATED and `-q` mutes the
  warning -- fine for a short-lived interactive command). Override with `FLY_API_TOKEN`
  for CI/headless; create that as a narrow read-only token via `fly tokens create`.
- **Scope:** the script + one `prod:logs:history` entry in `package.json` (defaults to
  `--app rpguild`).

## The Fly Logs API (verified against prod today)

- **Request:** `GET https://api.fly.io/api/v1/apps/<app>/logs`
- **Auth header:** `Authorization: FlyV1 <token>` — **not** `Bearer` (Bearer returns 401;
  verified). Token from `fly auth token -q` or `$FLY_API_TOKEN`.
- **Query params:** `next_token` (nanosecond epoch cursor, **inclusive** start),
  optional `region` (e.g. `dfw`), optional `instance` (machine id). The base `.../logs`
  URL has **no `?`**, so build the query with `curl --get --data-urlencode` rather than
  hand-concatenating `&param=` (which would produce a malformed `.../logs&next_token=`).
- **Response:** `{ data: [ { id, type, attributes: { timestamp, message, level,
  instance, region, meta } } ], meta: { next_token } }`. ~100 records/page.
- **Pagination:** pass `meta.next_token` back as the next `next_token`. Because the start
  boundary is inclusive, `meta.next_token` equals the last record's exact timestamp, so
  the last record of page N reappears as the first of page N+1 → **dedup by record `id`**.
- **Live edge / termination:** when there are no more logs, the API returns `data: []`
  and `meta.next_token: ""`.
- **Retention:** ~7 days. Fly documents this endpoint as "not officially supported for
  external use" — treat as best-effort; note it in the script header.

## File to add: `scripts/fly-logs.sh`

New file, no shebang-executable bit needed (invoked via `bash`/npm), but include
`#!/usr/bin/env bash` + `set -euo pipefail` for correctness. Mirror the header-comment
style of `scripts/antispam-probe.ts` (purpose + `Usage:` block).

### CLI contract

```
scripts/fly-logs.sh <start> [end] [-g|--grep PATTERN] [-r|--region REGION] \
                    [-i|--instance MACHINE_ID] [--app APP]
```

- `<start>` (required): any `Date`-parseable string (`2026-07-01T12:00:00Z`, local time,
  etc.) **or** a relative shorthand `N[smhd]` meaning "N ago" (e.g. `2h`, `30m`).
- `[end]` (optional): same parsing; defaults to **now** (so it terminates at the live edge).
- `-g/--grep PATTERN`: keep only records whose `message` matches (case-insensitive ERE).
- `-r/--region` / `-i/--instance`: passed through as query params to narrow server-side.
- `--app APP`: defaults to `rpguild`.

### Dependencies & startup guards (all verified present locally)

- `jq` — parse each page's JSON.
- `node` — timestamp parsing via the `parse_time_to_ns` helper below (Node is guaranteed;
  it's the app runtime, v24 present), avoiding BSD-vs-GNU `date` portability branches.
- `fly` — only for the default `fly auth token -q`; **not** needed when `FLY_API_TOKEN`
  is set.
- **Startup guards** (before any work):
  - Tools: `command -v jq node >/dev/null || { echo "needs jq + node"; exit 1; }`.
  - `fly` only when the token env var is unset:
    `[[ -n ${FLY_API_TOKEN:-} ]] || command -v fly >/dev/null || { echo "needs fly, or set FLY_API_TOKEN"; exit 1; }`.
  - **Bash 4+** (the `seen` associative array needs it):
    `((BASH_VERSINFO[0] >= 4)) || { echo "needs bash >= 4 (stock macOS bash is 3.2; use nix/Homebrew bash)"; exit 1; }`.
    Local bash is 5.3, but `#!/usr/bin/env bash` can resolve to 3.2 on a stock Mac.

### `parse_time_to_ns` helper

The CLI contract accepts three forms — `now`, a relative `N[smhd]`-ago shorthand, and any
ISO/`Date`-parseable string — but a bare `Date.parse('30m')` / `Date.parse('now')` returns
`NaN`. One Node call handles all three and rejects garbage so bad input aborts instead of
producing a `NaN` cursor:

```bash
parse_time_to_ns() {
  node -e '
    const s = process.argv[1];
    let ms;
    if (s === "now") ms = Date.now();
    else if (/^\d+[smhd]$/.test(s)) {
      const n = +s.slice(0, -1);
      const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[s.slice(-1)];
      ms = Date.now() - n * mult;
    } else ms = Date.parse(s);
    if (Number.isNaN(ms)) { console.error(`bad time: ${s}`); process.exit(1); }
    process.stdout.write(String(ms * 1_000_000)); // ms -> ns
  ' "$1"
}
```

Callers must propagate its exit status (`start_ns=$(parse_time_to_ns "$1") || exit 1`) so a
bad time aborts the run.

### Algorithm

```
token = ${FLY_API_TOKEN:-$(fly auth token -q)}
start_ns = parse_time_to_ns "<start>"      || exit 1
end_ns   = parse_time_to_ns "${end:-now}"  || exit 1
cursor   = start_ns
declare -A seen                  # record id -> 1, for dedup (needs bash 4+)
base_url = https://api.fly.io/api/v1/apps/$APP/logs   # note: no '?'

loop (with a safety cap, e.g. 1000 pages):
  # Let curl assemble the query string (--get moves --data-urlencode fields into it),
  # so region/instance are optional and everything is properly encoded:
  page = curl -sS --fail --get "$base_url" \
           -H "Authorization: FlyV1 $token" \
           --data-urlencode "next_token=$cursor" \
           [ --data-urlencode "region=$REGION"   if -r given ] \
           [ --data-urlencode "instance=$INSTANCE" if -i given ]
  rows = jq -c '.data[]' <<<"$page"
  [ -z "$rows" ] && break                        # empty page => live edge
  while read row:
     id = .id; ts = .attributes.timestamp; msg = .attributes.message
     region = .attributes.region; inst = .attributes.instance
     [[ ${seen[$id]+x} ]] && continue; seen[$id]=1
     ts_ns = parse_time_to_ns "$ts"               # ISO from API => Date.parse path
     (( ts_ns > end_ns )) && break 2              # passed the window => done
     if grep set and ! printf '%s' "$msg" | grep -qiE -- "$pattern": continue
     printf '%s  %s  %s  %s\n' "$ts" "$region" "$inst" "$msg"
  next = jq -r '.meta.next_token' <<<"$page"
  [[ -z "$next" || "$next" == "$cursor" ]] && break
  cursor = $next
```

Output columns roughly match `fly logs`: `<timestamp>  <region>  <instance>  <message>`.
Each physical log line is its own API record (multi-line `console.log` dumps arrive as
consecutive records), so no special multi-line handling is needed.

## `package.json` change

Add next to `prod:logs` (keep the `<env>:<verb>` family; the `"// ===="` divider keys stay):

```json
"prod:logs": "fly logs --app rpguild",
"prod:logs:history": "bash scripts/fly-logs.sh",
```

Usage then: `pnpm run prod:logs:history -- "2026-07-01T12:00:00Z" "2026-07-01T13:00:00Z" -g 'antispam|nuke'`
(the `--` passes args through pnpm). Direct invocation also works:
`bash scripts/fly-logs.sh 2h -g antispam`. `--app` defaults to `rpguild`; pass `--app
rpguild-staging` for staging (no separate staging npm entry, per chosen scope).

## Out of scope (note only)

- The actual bypass root cause — Claude classifier 10s timeout failing open
  (`server/services/antispam/claude.ts:14`, `policy.ts:16`). Fixing that (longer timeout,
  single retry before fail-open, and/or logging the post title on fail-open so timeouts
  are attributable) is a **separate task**.
- Any log-shipper / Better Stack / Axiom durable-retention setup (beyond the 7-day
  window) — separate, larger decision.

## Automated test: `scripts/fly-logs.test.ts`

Offline Vitest so the non-trivial local behavior (query params, time parsing, grep,
pagination, dedup) is caught by `pnpm test` instead of only surfacing mid-incident against
live prod. vitest's default include already picks up `scripts/*.test.ts` (the config only
`exclude`s `img-proxy/**` — verified), so no config change is needed.

Shape — no network, no real Fly:

- Make a temp dir, write fake `curl` and `fly` executables into it, and prepend it to
  `PATH` for the spawned script (`execFile('bash', ['scripts/fly-logs.sh', ...args], { env })`).
- **fake `fly`**: prints a dummy token and exits 0 (also asserts the script tolerates the
  `-q` flag).
- **fake `curl`**: appends its argv to a capture file (so the test can assert on the
  request), then emits a fixture JSON page chosen by the requested `next_token` — this lets
  one invocation drive multi-page pagination. Provide 2–3 fixture pages, the last being an
  empty edge page (`{"data":[],"meta":{"next_token":""}}`).
- Assertions (behavioral, structure-insensitive — assert on emitted timestamps/messages and
  captured request params, not on internal variable names or exact formatting):
  1. **Query params** — captured `curl` argv contains `--get` and `next_token=<start ns>`,
     and includes `region=`/`instance=` only when `-r`/`-i` were passed.
  2. **Time parsing** — `30m` and an omitted end (`now`) yield a numeric cursor (no error);
     a garbage time (`nope`) exits non-zero with a `bad time` message.
  3. **grep** — with `-g antispam`, only matching lines are printed.
  4. **Pagination** — a window spanning two fixture pages prints rows from both, in order.
  5. **Dedup** — when page 2's first record repeats page 1's last `id` (the inclusive-cursor
     boundary), that line is printed exactly once.
  6. **Live edge** — the empty final page terminates the loop (clean exit 0, no hang).

## Verification

1. **Automated:** `pnpm test` runs `scripts/fly-logs.test.ts` (above) — offline coverage of
   query params, time parsing, grep, pagination, dedup, and live-edge termination. Also
   `bash -n scripts/fly-logs.sh` (syntax) and optionally `shellcheck`. Note the bash file is
   not covered by `pnpm run check` (tsconfig `include` excludes `scripts/`) or
   `pnpm run prettier` (server-only glob).
2. **Recover today's incident (end-to-end):**
   ```
   bash scripts/fly-logs.sh "2026-07-01T12:00:00Z" "2026-07-01T12:15:00Z" -g "antispam|nuke"
   ```
   Expect to see the `antispam process: { action: 'ALLOW', result: { ok: false, error:
   'API_TIMEOUT' } }` line at `12:08:22Z` — proves auth (FlyV1), pagination, time-window
   filtering, and grep all work.
3. **Relative shorthand + live edge:** `bash scripts/fly-logs.sh 30m` prints the last
   30 min and exits cleanly at the live edge (empty page), not hanging.
4. **npm wiring:** `pnpm run prod:logs:history -- 10m -g antispam` produces the same
   output via the package script.
5. **Dedup:** confirm no duplicated lines across page boundaries when a window spans
   >100 records (e.g. a multi-hour range), since the inclusive cursor re-returns the
   boundary record.

## Implementation notes

- `parse_time_to_ns` keeps the plan's Node-based parser but uses `BigInt` for the
  millisecond-to-nanosecond conversion so emitted cursors stay exact at current epoch sizes.
- The startup guard also checks for `curl`, because every API request depends on it even
  though the original dependency list only called out `jq`, `node`, and `fly`.

## Follow Up

- `server/services/antispam/claude.ts:14` and `server/services/antispam/policy.ts:16`
  still fail open on Claude classifier timeout; tune timeout/retry behavior and timeout
  logging in a separate antispam change.
- Durable log retention beyond the best-effort Fly Logs API window still needs a separate
  log-shipping decision if Guild needs more than about 7 days of lookback.
