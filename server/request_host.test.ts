import { describe, expect, it } from "vitest";

import { namesRequestHost } from "./request_host";

describe("namesRequestHost", () => {
  it.each([
    ["https://www.roleplayerguild.com", "www.roleplayerguild.com"],
    // A Referer carries a path, a query and a fragment; only its host counts.
    [
      "https://www.roleplayerguild.com/topics/1?page=2#post-3",
      "www.roleplayerguild.com",
    ],
    // Hostnames ignore case.
    ["https://www.roleplayerguild.com", "WWW.RolePlayerGuild.COM"],
    // The Host is read under the URL's scheme, so a default port is no port.
    ["https://www.roleplayerguild.com", "www.roleplayerguild.com:443"],
    ["http://localhost", "localhost:80"],
    ["http://localhost:3000", "localhost:3000"],
    ["http://127.0.0.1:3000", "127.0.0.1:3000"],
    ["http://[::1]:3000", "[::1]:3000"],
    ["http://[::1]:3000", "[0:0:0:0:0:0:0:1]:3000"],
    // Scheme is not compared: TLS ends before Node, so the Host cannot say it.
    ["http://www.roleplayerguild.com", "www.roleplayerguild.com"],
  ])("%s names Host %j", (url, host) => {
    expect(namesRequestHost(new URL(url), host)).toBe(true);
  });

  it.each([
    // Another host, however close.
    ["https://evilroleplayerguild.com", "roleplayerguild.com"],
    ["https://img.roleplayerguild.com", "roleplayerguild.com"],
    ["https://roleplayerguild.com", "www.roleplayerguild.com"],
    ["https://rpguild-staging.fly.dev", "www.roleplayerguild.com"],
    ["http://[::2]:3000", "[::1]:3000"],
    // Another port. Under http, 443 is a port like any other.
    ["http://localhost:3001", "localhost:3000"],
    ["http://localhost", "localhost:3000"],
    ["http://www.roleplayerguild.com", "www.roleplayerguild.com:443"],
    // Only http and https URLs name a web host.
    ["ws://www.roleplayerguild.com", "www.roleplayerguild.com"],
    ["chrome-extension://abcdef", "abcdef"],
  ])("%s does not name Host %j", (url, host) => {
    expect(namesRequestHost(new URL(url), host)).toBe(false);
  });

  // Intent: a Host that is missing or not a bare host and port names nothing.
  // Why it exists: the URL parser forgives what a Host header must not hold.
  // It reads userinfo and paths, strips tabs, and decodes percent escapes, so
  // each value below would otherwise parse to www.roleplayerguild.com.
  // Scenario: each row pairs the own Origin with a missing or garbled Host.
  it.each([
    [undefined],
    [""],
    ["www.roleplayerguild.com/"],
    ["www.roleplayerguild.com/x"],
    ["www.roleplayerguild.com\\x"],
    ["www.roleplayerguild.com?x"],
    ["www.roleplayerguild.com#x"],
    ["evil.example@www.roleplayerguild.com"],
    ["www.role\tplayerguild.com"],
    ["www.roleplayerguil%64.com"],
    ["www.roleplayerguild.com:99999"],
    ["www.roleplayerguild.com:http"],
    [":443"],
  ])("refuses Host %j", (host) => {
    const own = new URL("https://www.roleplayerguild.com");

    expect(namesRequestHost(own, host)).toBe(false);
  });

  it("refuses an IPv6 Host without brackets", () => {
    expect(namesRequestHost(new URL("http://[::1]"), "::1")).toBe(false);
  });
});
