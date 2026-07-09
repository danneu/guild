import { afterEach, describe, expect, it } from "vitest";

import {
  classifyIp,
  DEFAULT_EGRESS_CIDRS,
  DEFAULT_PROXY_CIDRS,
  isCloudflareEgressIp,
  isCloudflareProxyIp,
  normalizeIp,
  parseGeofeedCidrs,
  parseProxyIpLists,
  refreshCloudflareIpRanges,
  resolveClientIp,
  setEgressRanges,
  setProxyRanges,
  shouldRejectOriginBypass,
} from "./cloudflare_ip";

// Realistic ips-v4 / ips-v6 bodies (the live published proxy lists).
const V4_BODY = [
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
].join("\n");
const V6_BODY = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
].join("\n");

const PROXY_V4_URL = "https://www.cloudflare.com/ips-v4";
const PROXY_V6_URL = "https://www.cloudflare.com/ips-v6";
const GEOFEED_URL = "https://api.cloudflare.com/local-ip-ranges.csv";

// Build a geofeed CSV in the real live shape (mostly /32 rows), plus a blank
// line, a `#` comment, the motivating WARP address as a real /32, and one
// malformed row that must be skipped.
function bigGeofeed(rows: number): string {
  const lines: string[] = [
    "# cloudflare local ip ranges",
    "",
    "104.28.203.54/32,US,US-WA,Seattle,,",
    "garbage-not-a-cidr,US",
  ];
  for (let i = 0; i < rows; i++) {
    const a = 10 + (i % 40);
    const b = (i >> 8) & 0xff;
    const c = i & 0xff;
    lines.push(`${a}.${b}.${c}.1/32,US,US-CA,City,,`);
  }
  return lines.join("\n");
}

function stubFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  }) as typeof fetch;
}

afterEach(() => {
  // Restore boot defaults so per-test mutation never leaks across tests.
  setProxyRanges(DEFAULT_PROXY_CIDRS);
  setEgressRanges(DEFAULT_EGRESS_CIDRS);
});

describe("normalizeIp", () => {
  it("trims, unwraps IPv4-mapped IPv6, and rejects garbage", () => {
    expect(normalizeIp("  8.8.8.8 ")).toBe("8.8.8.8");
    expect(normalizeIp("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(normalizeIp("2400:cb00::1")).toBe("2400:cb00::1");
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp("banana")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
  });
});

describe("proxy / egress membership", () => {
  it("matches representative Cloudflare proxy IPs", () => {
    for (const ip of [
      "104.16.0.1",
      "172.71.10.5",
      "162.158.1.1",
      "2400:cb00::1",
      "2606:4700:4700::1111",
      "::ffff:104.16.0.1",
    ]) {
      expect(isCloudflareProxyIp(ip)).toBe(true);
    }
  });

  it("does not match non-Cloudflare IPs as proxy", () => {
    for (const ip of ["8.8.8.8", "127.0.0.1", "::1", "fdaa:0:1::2"]) {
      expect(isCloudflareProxyIp(ip)).toBe(false);
    }
  });

  it("classifies 104.28.203.54 as egress but NOT proxy (disjoint where it matters)", () => {
    expect(isCloudflareProxyIp("104.28.203.54")).toBe(false);
    expect(isCloudflareEgressIp("104.28.203.54")).toBe(true);
  });

  it("respects egress boundaries", () => {
    expect(isCloudflareEgressIp("104.28.0.0")).toBe(true);
    expect(isCloudflareEgressIp("104.31.255.255")).toBe(true);
    expect(isCloudflareEgressIp("104.27.255.255")).toBe(false);
    expect(isCloudflareEgressIp("104.32.0.0")).toBe(false);
  });

  it("matches the v6 egress supernets", () => {
    expect(isCloudflareEgressIp("2a09:bac0::1")).toBe(true);
    expect(isCloudflareEgressIp("2606:54c0::1")).toBe(true);
  });

  it("returns false for garbage and never throws", () => {
    for (const ip of ["", "banana", "999.1.1.1"]) {
      expect(isCloudflareProxyIp(ip)).toBe(false);
      expect(isCloudflareEgressIp(ip)).toBe(false);
    }
  });
});

describe("resolveClientIp", () => {
  it("returns the cf header on the through-Cloudflare happy path", () => {
    expect(
      resolveClientIp({
        flyClientIp: "104.16.0.1",
        cfConnectingIp: "203.0.113.9",
        socketIp: "104.16.0.1",
      }),
    ).toBe("203.0.113.9");
  });

  it("ignores a forged cf header on a direct origin hit", () => {
    expect(
      resolveClientIp({
        flyClientIp: "198.51.100.7",
        cfConnectingIp: "8.8.8.8",
        socketIp: "198.51.100.7",
      }),
    ).toBe("198.51.100.7");
  });

  it("falls back to the socket IP when no headers are present", () => {
    expect(
      resolveClientIp({
        flyClientIp: undefined,
        cfConnectingIp: undefined,
        socketIp: "198.51.100.7",
      }),
    ).toBe("198.51.100.7");
  });

  it("passes a WARP egress IP through faithfully when routed via Cloudflare", () => {
    expect(
      resolveClientIp({
        flyClientIp: "104.16.0.1",
        cfConnectingIp: "104.28.203.54",
        socketIp: "104.16.0.1",
      }),
    ).toBe("104.28.203.54");
  });

  it("resolves IPv6 end-to-end", () => {
    expect(
      resolveClientIp({
        flyClientIp: "2400:cb00::1",
        cfConnectingIp: "2001:db8::5",
        socketIp: "2400:cb00::1",
      }),
    ).toBe("2001:db8::5");
  });

  it("normalizes a mapped-IPv4 socket to a dotted quad", () => {
    expect(
      resolveClientIp({
        flyClientIp: undefined,
        cfConnectingIp: undefined,
        socketIp: "::ffff:198.51.100.7",
      }),
    ).toBe("198.51.100.7");
  });

  it("falls back to the socket when fly-client-ip is garbage", () => {
    expect(
      resolveClientIp({
        flyClientIp: "banana",
        cfConnectingIp: undefined,
        socketIp: "198.51.100.7",
      }),
    ).toBe("198.51.100.7");
  });

  it("ignores a garbage cf header", () => {
    expect(
      resolveClientIp({
        flyClientIp: "104.16.0.1",
        cfConnectingIp: "banana",
        socketIp: "104.16.0.1",
      }),
    ).toBe("104.16.0.1");
  });
});

describe("classifyIp", () => {
  it("classifies an egress IP as cloudflare_egress", () => {
    expect(classifyIp("104.28.203.54")).toBe("cloudflare_egress");
  });

  it("classifies a proxy IP as cloudflare_proxy", () => {
    expect(classifyIp("104.16.0.1")).toBe("cloudflare_proxy");
  });

  it("returns null for ordinary, null, and garbage IPs", () => {
    expect(classifyIp("8.8.8.8")).toBeNull();
    expect(classifyIp(null)).toBeNull();
    expect(classifyIp(undefined)).toBeNull();
    expect(classifyIp("banana")).toBeNull();
  });

  it("prefers cloudflare_proxy even when the egress source includes proxy space", () => {
    // Simulate an unfiltered geofeed that mixes in a proxy-space CIDR.
    setEgressRanges(["104.16.0.0/13", "104.28.0.0/14"]);
    expect(classifyIp("104.16.0.1")).toBe("cloudflare_proxy");
  });
});

describe("shouldRejectOriginBypass", () => {
  it("never rejects when disabled", () => {
    expect(
      shouldRejectOriginBypass({
        enabled: false,
        path: "/",
        flyClientIp: "8.8.8.8",
      }),
    ).toBe(false);
  });

  it("never rejects the health check", () => {
    expect(
      shouldRejectOriginBypass({
        enabled: true,
        path: "/health",
        flyClientIp: "8.8.8.8",
      }),
    ).toBe(false);
  });

  it("does not reject a Fly health-check shape (empty fly-client-ip)", () => {
    expect(
      shouldRejectOriginBypass({ enabled: true, path: "/", flyClientIp: "" }),
    ).toBe(false);
    expect(
      shouldRejectOriginBypass({
        enabled: true,
        path: "/",
        flyClientIp: undefined,
      }),
    ).toBe(false);
  });

  it("does not reject a Cloudflare proxy peer", () => {
    expect(
      shouldRejectOriginBypass({
        enabled: true,
        path: "/",
        flyClientIp: "104.16.0.1",
      }),
    ).toBe(false);
  });

  it("rejects a non-Cloudflare peer", () => {
    expect(
      shouldRejectOriginBypass({
        enabled: true,
        path: "/",
        flyClientIp: "8.8.8.8",
      }),
    ).toBe(true);
  });

  it("rejects an unparseable (but present) peer -- unknown is not Cloudflare", () => {
    expect(
      shouldRejectOriginBypass({
        enabled: true,
        path: "/",
        flyClientIp: "banana",
      }),
    ).toBe(true);
  });
});

describe("parseProxyIpLists", () => {
  it("round-trips the real ips-v4 + ips-v6 bodies", () => {
    const cidrs = parseProxyIpLists(V4_BODY, V6_BODY);
    expect(cidrs).toContain("104.16.0.0/13");
    expect(cidrs.length).toBe(15 + 7);
  });

  it("tolerates trailing whitespace and blank lines", () => {
    const cidrs = parseProxyIpLists(V4_BODY + "\n\n", "  " + V6_BODY + "\n");
    expect(cidrs.length).toBe(15 + 7);
  });

  it("throws on an HTML body", () => {
    expect(() =>
      parseProxyIpLists("<html><body>nope</body></html>", V6_BODY),
    ).toThrow();
  });

  it("throws on an invalid line", () => {
    expect(() =>
      parseProxyIpLists(V4_BODY + "\nnot-a-cidr", V6_BODY),
    ).toThrow();
  });

  it("throws when there are too few v4 entries", () => {
    expect(() => parseProxyIpLists("104.16.0.0/13", V6_BODY)).toThrow();
  });

  it("throws when there are too few v6 entries", () => {
    expect(() => parseProxyIpLists(V4_BODY, "2400:cb00::/32")).toThrow();
  });

  it("throws when the 104.16.0.0/13 anchor is missing", () => {
    const noAnchor = V4_BODY.split("\n").filter((l) => l !== "104.16.0.0/13");
    expect(() => parseProxyIpLists(noAnchor.join("\n"), V6_BODY)).toThrow(
      /anchor/,
    );
  });
});

describe("parseGeofeedCidrs", () => {
  it("parses live-shape rows, skipping blanks, comments, and malformed rows", () => {
    const cidrs = parseGeofeedCidrs(bigGeofeed(10_000));
    expect(cidrs).toContain("104.28.203.54/32");
    expect(cidrs).not.toContain("garbage-not-a-cidr");
    expect(cidrs.length).toBe(10_001);
  });

  it("throws when there are fewer than 10,000 valid rows", () => {
    expect(() => parseGeofeedCidrs(bigGeofeed(100))).toThrow(/too small/i);
  });
});

describe("setProxyRanges / setEgressRanges", () => {
  it("replaces the proxy set rather than unioning with defaults", () => {
    setProxyRanges(["198.51.100.0/24"]);
    expect(isCloudflareProxyIp("198.51.100.5")).toBe(true);
    expect(isCloudflareProxyIp("104.16.0.1")).toBe(false);
    // resolveClientIp trust follows the new set
    expect(
      resolveClientIp({
        flyClientIp: "198.51.100.5",
        cfConnectingIp: "8.8.8.8",
        socketIp: "198.51.100.5",
      }),
    ).toBe("8.8.8.8");
    expect(
      resolveClientIp({
        flyClientIp: "104.16.0.1",
        cfConnectingIp: "8.8.8.8",
        socketIp: "104.16.0.1",
      }),
    ).toBe("104.16.0.1");
  });

  it("subtracts proxy-space rows from a raw geofeed and keeps exact egress rows", () => {
    // 103.22.200.0/24 is inside default proxy 103.22.200.0/22; the /32 is not.
    setEgressRanges(["103.22.200.0/24", "104.28.203.54/32"]);
    expect(isCloudflareEgressIp("103.22.200.5")).toBe(false);
    expect(isCloudflareEgressIp("104.28.203.54")).toBe(true);
  });

  it("re-derives effective egress when the proxy set GROWS (partial refresh)", () => {
    setEgressRanges(["104.28.0.0/14"]);
    expect(isCloudflareEgressIp("104.28.203.54")).toBe(true);
    // Cloudflare newly proxifies the range, with NO subsequent geofeed refresh.
    setProxyRanges(["104.28.203.0/24"]);
    expect(isCloudflareEgressIp("104.28.203.54")).toBe(false);
    expect(isCloudflareProxyIp("104.28.203.54")).toBe(true);
  });

  it("restores effective egress when the proxy set SHRINKS (raw-geofeed retention)", () => {
    setEgressRanges(["104.28.0.0/14"]);
    setProxyRanges(["104.28.203.0/24"]);
    expect(isCloudflareEgressIp("104.28.203.54")).toBe(false);
    // Cloudflare pulls the range back out of proxy space, with NO geofeed refresh.
    setProxyRanges(["198.51.100.0/24"]);
    expect(isCloudflareEgressIp("104.28.203.54")).toBe(true);
    expect(isCloudflareProxyIp("104.28.203.54")).toBe(false);
  });
});

describe("refreshCloudflareIpRanges", () => {
  it("replaces both sets from valid payloads", async () => {
    setProxyRanges(["198.51.100.0/24"]); // prove replacement from a nondefault state
    await refreshCloudflareIpRanges(
      stubFetch({
        [PROXY_V4_URL]: () => new Response(V4_BODY),
        [PROXY_V6_URL]: () => new Response(V6_BODY),
        [GEOFEED_URL]: () => new Response(bigGeofeed(10_000)),
      }),
    );
    expect(isCloudflareProxyIp("104.16.0.1")).toBe(true);
    expect(isCloudflareProxyIp("198.51.100.5")).toBe(false);
    expect(isCloudflareEgressIp("104.28.203.54")).toBe(true);
  });

  it("still applies the proxy update when the geofeed fetch rejects, keeping sets disjoint", async () => {
    setProxyRanges(["198.51.100.0/24"]); // proxy without 104.16 ...
    setEgressRanges(["104.16.0.0/13"]); // ... so raw egress can hold 104.16
    expect(isCloudflareEgressIp("104.16.0.1")).toBe(true);

    await expect(
      refreshCloudflareIpRanges(
        stubFetch({
          [PROXY_V4_URL]: () => new Response(V4_BODY), // includes 104.16.0.0/13
          [PROXY_V6_URL]: () => new Response(V6_BODY),
          [GEOFEED_URL]: () => Promise.reject(new Error("network down")),
        }),
      ),
    ).resolves.toBeUndefined();

    expect(isCloudflareProxyIp("104.16.0.1")).toBe(true); // proxy update applied
    expect(isCloudflareEgressIp("104.16.0.1")).toBe(false); // re-derived: proxy CIDR out of egress
  });

  it("keeps the previous proxy set when the live proxy body is below the floor", async () => {
    setProxyRanges(["198.51.100.0/24"]);
    await refreshCloudflareIpRanges(
      stubFetch({
        [PROXY_V4_URL]: () => new Response("104.16.0.0/13"), // 1 v4 entry -> parse throws
        [PROXY_V6_URL]: () => new Response(V6_BODY),
        [GEOFEED_URL]: () => Promise.reject(new Error("skip geofeed")),
      }),
    );
    expect(isCloudflareProxyIp("198.51.100.5")).toBe(true); // unchanged
    expect(isCloudflareProxyIp("104.16.0.1")).toBe(false);
  });
});
