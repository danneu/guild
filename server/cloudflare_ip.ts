// Trusted client-IP resolution + Cloudflare range classification.
//
// Zero app dependencies (imports only Node's `net`) so it stays pure and
// cycle-free: index.ts, routes/users.ts, and presenters.ts import it.
//
// Matching is done with sorted, merged integer intervals + binary search
// rather than net.BlockList: the egress geofeed is ~138k mostly-/32 CIDRs
// that merge into a few thousand dense intervals (BlockList would hold all
// 138k rules and scan O(n) natively), and the matcher must be rebuilt
// atomically when the refresh job (below) replaces a range set.
//
// IPv4 and IPv6 addresses are both represented as BigInt (v4 in 0..2^32-1,
// v6 in 0..2^128-1) and kept in per-family interval arrays so families never
// cross-match. Uniform BigInt keeps the interval-subtraction helper simple.

import net from "net";

// Source: https://www.cloudflare.com/ips-v4 + /ips-v6 (2026-07-09).
// Boot values; replaced at runtime by the refresh job (section 2). Exported
// for tests (afterEach restore).
export const DEFAULT_PROXY_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];
// Shared WARP / iCloud Private Relay exit supernets, derived from
// https://api.cloudflare.com/local-ip-ranges.csv (2026-07-09). Boot values;
// replaced at runtime from the same geofeed by the refresh job.
export const DEFAULT_EGRESS_CIDRS = [
  "104.28.0.0/14",
  "2a09:bac0::/29",
  "2606:54c0::/28",
];

const PROXY_NOTE =
  "Cloudflare proxy IP -- likely recorded before trusted IP resolution shipped, not a real client address";
const EGRESS_NOTE =
  "Cloudflare WARP / iCloud Private Relay egress -- shared VPN exit used by many users, not unique to this account";

// -------------------------------------------------------------------------
// Interval representation
// -------------------------------------------------------------------------

type Interval = { start: bigint; end: bigint };
type IntervalSet = { v4: Interval[]; v6: Interval[] };

function parseIpToBigInt(ip: string): { value: bigint; family: 4 | 6 } | null {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const n = Number(part);
      if (n > 255) return null;
      value = (value << 8n) | BigInt(n);
    }
    return { value, family: 4 };
  }
  if (family === 6) {
    const value = parseIpv6(ip);
    if (value === null) return null;
    return { value, family: 6 };
  }
  return null;
}

function parseIpv6(ip: string): bigint | null {
  // Drop an IPv6 zone id (fe80::1%eth0) if present.
  const pct = ip.indexOf("%");
  const addr = pct === -1 ? ip : ip.slice(0, pct);

  function toGroups(part: string): string[] | null {
    if (part === "") return [];
    const groups = part.split(":");
    const out: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (g.includes(".")) {
        // Embedded dotted-quad, valid only as the final group.
        if (i !== groups.length - 1) return null;
        const v4 = parseIpToBigInt(g);
        if (!v4 || v4.family !== 4) return null;
        out.push(((v4.value >> 16n) & 0xffffn).toString(16));
        out.push((v4.value & 0xffffn).toString(16));
      } else {
        out.push(g);
      }
    }
    return out;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  let groups: string[];
  if (halves.length === 2) {
    const left = toGroups(halves[0]!);
    const right = toGroups(halves[1]!);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  } else {
    const all = toGroups(addr);
    if (!all) return null;
    groups = all;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function cidrToInterval(cidr: string): { interval: Interval; family: 4 | 6 } {
  const slash = cidr.indexOf("/");
  if (slash === -1) throw new Error(`Invalid CIDR (no prefix): ${cidr}`);
  const addr = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  const parsed = parseIpToBigInt(addr);
  if (!parsed) throw new Error(`Invalid CIDR address: ${cidr}`);
  const bits = parsed.family === 4 ? 32 : 128;
  if (!/^\d{1,3}$/.test(prefixStr)) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const prefix = Number(prefixStr);
  if (prefix > bits) throw new Error(`Invalid CIDR prefix: ${cidr}`);
  const hostBits = BigInt(bits - prefix);
  const mask = hostBits === 0n ? 0n : (1n << hostBits) - 1n;
  const start = parsed.value - (parsed.value & mask);
  const end = start + mask;
  return { interval: { start, end }, family: parsed.family };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  );
  const merged: Interval[] = [];
  let cur: Interval = { ...sorted[0]! };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    // Merge overlapping OR adjacent intervals.
    if (next.start <= cur.end + 1n) {
      if (next.end > cur.end) cur.end = next.end;
    } else {
      merged.push(cur);
      cur = { ...next };
    }
  }
  merged.push(cur);
  return merged;
}

function buildIntervals(cidrs: string[]): IntervalSet {
  const v4: Interval[] = [];
  const v6: Interval[] = [];
  for (const cidr of cidrs) {
    const { interval, family } = cidrToInterval(cidr.trim());
    (family === 4 ? v4 : v6).push(interval);
  }
  return { v4: mergeIntervals(v4), v6: mergeIntervals(v6) };
}

// Subtract merged interval list `b` from merged interval list `a`. Output is
// sorted and disjoint (each a-interval yields left-to-right remainders).
function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const iv of a) {
    let segments: Interval[] = [{ start: iv.start, end: iv.end }];
    for (const bIv of b) {
      if (bIv.end < iv.start || bIv.start > iv.end) continue; // no overlap
      const next: Interval[] = [];
      for (const seg of segments) {
        if (bIv.end < seg.start || bIv.start > seg.end) {
          next.push(seg);
          continue;
        }
        if (seg.start < bIv.start) {
          next.push({ start: seg.start, end: bIv.start - 1n });
        }
        if (seg.end > bIv.end) {
          next.push({ start: bIv.end + 1n, end: seg.end });
        }
      }
      segments = next;
    }
    for (const seg of segments) result.push(seg);
  }
  return result;
}

function subtractSets(a: IntervalSet, b: IntervalSet): IntervalSet {
  return {
    v4: subtractIntervals(a.v4, b.v4),
    v6: subtractIntervals(a.v6, b.v6),
  };
}

function intervalsContain(intervals: Interval[], value: bigint): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = intervals[mid]!;
    if (value < iv.start) hi = mid - 1;
    else if (value > iv.end) lo = mid + 1;
    else return true;
  }
  return false;
}

function setContains(set: IntervalSet, ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const parsed = parseIpToBigInt(normalized);
  if (!parsed) return false;
  const intervals = parsed.family === 4 ? set.v4 : set.v6;
  return intervalsContain(intervals, parsed.value);
}

// -------------------------------------------------------------------------
// Mutable module-level range sets
//
// Three sets keep the disjoint invariant surviving a partial refresh (one
// step succeeds, the other fails) in either direction, including a shrinking
// proxy list:
//   - proxyIntervals    : current proxy set (what isCloudflareProxyIp reads)
//   - rawEgressIntervals : last raw geofeed, unfiltered; never read by a
//     predicate, retained only as the derivation source
//   - egressIntervals   : effective egress (what isCloudflareEgressIp reads),
//     always rawEgressIntervals - proxyIntervals
// -------------------------------------------------------------------------

let proxyIntervals: IntervalSet = buildIntervals(DEFAULT_PROXY_CIDRS);
let rawEgressIntervals: IntervalSet = buildIntervals(DEFAULT_EGRESS_CIDRS);
let egressIntervals: IntervalSet = subtractSets(
  rawEgressIntervals,
  proxyIntervals,
);
// Retained purely for the refresh job's diff log (see refreshCloudflareIpRanges).
let lastProxyCidrs: string[] = [...DEFAULT_PROXY_CIDRS];

// Replace the proxy set (no union with defaults: Cloudflare's live endpoint is
// authoritative, and unioning forever would keep trusting cf-connecting-ip
// from ranges Cloudflare has relinquished -- a stale spoofing path). Throws on
// invalid CIDRs before mutating, so a rejected refresh keeps the current set.
export function setProxyRanges(cidrs: string[]): void {
  const next = buildIntervals(cidrs);
  proxyIntervals = next;
  // Re-derive effective egress from the retained RAW geofeed (not the
  // already-filtered egressIntervals) so a range Cloudflare pulls out of proxy
  // space is restored to egress even if the next geofeed fetch fails.
  egressIntervals = subtractSets(rawEgressIntervals, proxyIntervals);
}

// Replace the raw geofeed set, then recompute effective egress. Throws on
// invalid CIDRs before mutating.
export function setEgressRanges(cidrs: string[]): void {
  const next = buildIntervals(cidrs);
  rawEgressIntervals = next;
  egressIntervals = subtractSets(rawEgressIntervals, proxyIntervals);
}

// -------------------------------------------------------------------------
// Public predicates / resolution
// -------------------------------------------------------------------------

// Trim, unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4 -> 1.2.3.4), validate with
// net.isIP; return null on garbage. Never throws.
export function normalizeIp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let ip = raw.trim();
  if (ip === "") return null;
  if (ip.toLowerCase().startsWith("::ffff:")) {
    const rest = ip.slice("::ffff:".length);
    if (net.isIP(rest) === 4) ip = rest;
  }
  return net.isIP(ip) ? ip : null;
}

export function isCloudflareProxyIp(ip: string): boolean {
  return setContains(proxyIntervals, ip);
}

export function isCloudflareEgressIp(ip: string): boolean {
  return setContains(egressIntervals, ip);
}

// Resolve the trusted client IP. The cf-connecting-ip header is honored only
// when the TCP peer (fly-client-ip, else socket) is a Cloudflare proxy edge;
// otherwise the peer is returned so a direct origin hit cannot forge the
// header. Never throws.
export function resolveClientIp({
  flyClientIp,
  cfConnectingIp,
  socketIp,
}: {
  flyClientIp: string | null | undefined;
  cfConnectingIp: string | null | undefined;
  socketIp: string | null | undefined;
}): string {
  const peer =
    normalizeIp(flyClientIp) ?? normalizeIp(socketIp) ?? socketIp ?? "";
  const cf = normalizeIp(cfConnectingIp);
  if (cf && isCloudflareProxyIp(peer)) return cf;
  return peer;
}

// Staff annotation for a stored IP. Proxy match is checked FIRST: the geofeed
// mixes proxy-edge rows into the egress source, so egress-first would mislabel
// proxy IPs as WARP exits after a refresh. (The effective egress set derived by
// the setters is disjoint from proxy space anyway; this ordering is defense in
// depth.) Returns null for ordinary/garbage/absent IPs. Never throws.
export function ipStaffNote(ip: string | null | undefined): string | null {
  const normalized = normalizeIp(ip);
  if (!normalized) return null;
  if (isCloudflareProxyIp(normalized)) return PROXY_NOTE;
  if (isCloudflareEgressIp(normalized)) return EGRESS_NOTE;
  return null;
}

// Pure decision behind the 403 origin-bypass middleware. Reject only when the
// flag is on, the path is not the health check, and the TCP peer is a
// non-Cloudflare address. An absent fly-client-ip is a Fly health check (they
// hit the origin directly); a present-but-unparseable value is an unknown peer
// and is rejected.
export function shouldRejectOriginBypass({
  enabled,
  path,
  flyClientIp,
}: {
  enabled: boolean;
  path: string;
  flyClientIp: string | null | undefined;
}): boolean {
  if (!enabled) return false;
  if (path === "/health") return false;
  const raw = (flyClientIp ?? "").trim();
  if (raw === "") return false;
  const normalized = normalizeIp(raw);
  if (!normalized) return true;
  return !isCloudflareProxyIp(normalized);
}

// -------------------------------------------------------------------------
// Range-list parsers (pure; unit-testable with fixture strings)
// -------------------------------------------------------------------------

// Parse the ips-v4 + ips-v6 bodies (one CIDR per line). Validated JOINTLY --
// ips-v6 alone has ~7 entries and no v4 anchor, so per-body checks against
// these thresholds would always fail for v6. Throws on any invalid line, too
// few v4/v6 entries, or a missing 104.16.0.0/13 anchor.
export function parseProxyIpLists(v4Text: string, v6Text: string): string[] {
  const v4 = splitLines(v4Text);
  const v6 = splitLines(v6Text);
  for (const line of [...v4, ...v6]) {
    cidrToInterval(line); // throws on any invalid CIDR (e.g. an HTML body)
  }
  if (v4.length < 10) throw new Error(`Too few IPv4 proxy CIDRs: ${v4.length}`);
  if (v6.length < 3) throw new Error(`Too few IPv6 proxy CIDRs: ${v6.length}`);
  if (!v4.includes("104.16.0.0/13")) {
    throw new Error("Missing IPv4 anchor 104.16.0.0/13 in proxy list");
  }
  return [...v4, ...v6];
}

// Parse the geofeed CSV: first column per line, skipping blank/#-comment/
// malformed rows. Throws under 10,000 valid rows (~138k today; guards
// truncated or HTML bodies).
export function parseGeofeedCidrs(csv: string): string[] {
  const out: string[] = [];
  for (const line of csv.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const first = trimmed.split(",")[0]!.trim();
    if (first === "") continue;
    try {
      cidrToInterval(first);
    } catch {
      continue; // skip malformed rows
    }
    out.push(first);
  }
  if (out.length < 10_000) {
    throw new Error(`Geofeed too small: ${out.length} rows`);
  }
  return out;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

// -------------------------------------------------------------------------
// Automatic refresh job (NOT a cache3 entry -- boot-safety is structural
// because this runs strictly after app.listen; see the plan's section 2)
// -------------------------------------------------------------------------

const PROXY_V4_URL = "https://www.cloudflare.com/ips-v4";
const PROXY_V6_URL = "https://www.cloudflare.com/ips-v6";
const GEOFEED_URL = "https://api.cloudflare.com/local-ip-ranges.csv";

// Two internally try/caught steps; step 2 runs even if step 1 fails. A failed
// step logs and keeps the current set. Never throws to the caller. fetchImpl
// exists purely for tests.
export async function refreshCloudflareIpRanges(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // Step 1: proxy ranges.
  try {
    const [v4Res, v6Res] = await Promise.all([
      fetchImpl(PROXY_V4_URL, { signal: AbortSignal.timeout(10_000) }),
      fetchImpl(PROXY_V6_URL, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!v4Res.ok) throw new Error(`ips-v4 fetch failed: ${v4Res.status}`);
    if (!v6Res.ok) throw new Error(`ips-v6 fetch failed: ${v6Res.status}`);
    const cidrs = parseProxyIpLists(await v4Res.text(), await v6Res.text());
    const added = cidrs.filter((c) => !lastProxyCidrs.includes(c));
    const removed = lastProxyCidrs.filter((c) => !cidrs.includes(c));
    setProxyRanges(cidrs);
    lastProxyCidrs = cidrs;
    if (added.length || removed.length) {
      console.log(
        `cloudflare_ip: proxy ranges updated (+${added.length} -${removed.length}); added [${added.join(", ")}] removed [${removed.join(", ")}]`,
      );
    } else {
      console.log(
        `cloudflare_ip: proxy ranges refreshed, no change (${cidrs.length} CIDRs)`,
      );
    }
  } catch (err) {
    console.error("cloudflare_ip: proxy range refresh failed:", err);
  }

  // Step 2: egress geofeed (~12MB).
  try {
    const res = await fetchImpl(GEOFEED_URL, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`geofeed fetch failed: ${res.status}`);
    const cidrs = parseGeofeedCidrs(await res.text());
    setEgressRanges(cidrs);
    console.log(
      `cloudflare_ip: egress ranges refreshed: ${cidrs.length} rows, ${egressIntervals.v4.length + egressIntervals.v6.length} effective intervals`,
    );
  } catch (err) {
    console.error("cloudflare_ip: egress range refresh failed:", err);
  }
}

let refreshStarted = false;

// Idempotent. Kicks off an immediate refresh, then every 12h. The interval is
// unref'd so scripts and tests never hang on it. Module import performs no I/O;
// only index.ts calls this (after app.listen).
export function startCloudflareIpRangeRefresh(): void {
  if (refreshStarted) return;
  refreshStarted = true;
  refreshCloudflareIpRanges().catch((err) =>
    console.error("cloudflare_ip: initial refresh error:", err),
  );
  setInterval(
    () => {
      refreshCloudflareIpRanges().catch((err) =>
        console.error("cloudflare_ip: scheduled refresh error:", err),
      );
    },
    1000 * 60 * 60 * 12,
  ).unref();
}
