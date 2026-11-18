import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context } from "koa";
import { describe, expect, it } from "vitest";

import { responseEdge } from "./response-edge";

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app over node:http: responseEdge, then a handler that sets one
// Location. node:http sends the Host header as given, as a browser would.

type SetBy = "redirect" | "set";

async function send(location: string, by: SetBy, host: string) {
  const app = new Koa();
  app.silent = true;
  app.use(responseEdge());
  app.use((ctx: Context) => {
    if (by === "redirect") {
      ctx.redirect(location);
      return;
    }
    // By hand, with no body, as middleware might. ctx.redirect would escape
    // some characters; this sends the value as is.
    ctx.status = 302;
    ctx.set("Location", location);
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: "/",
            headers: { host },
            agent: false,
          },
          resolve,
        )
        .on("error", reject);
    });
    res.resume();
    return { status: res.statusCode, location: res.headers.location };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const OWN = "www.roleplayerguild.com";

describe("responseEdge", () => {
  // Intent: a response keeps its Location only when a browser on http or https
  // would follow it to the request's own host, or when it is an https URL on
  // the edge's outside list. Any other answers 500 without the header.
  // Why it exists: hunt 261117-0852-032. Routes that redirected to a target
  // from the request checked it each their own way, three not at all, and
  // nothing checked the Location a response finally carried.
  // Scenario: each row sets one Location, through ctx.redirect or by hand on
  // an empty body, for a request to the given Host.
  it.each([
    { location: "/users/x?a=1", by: "redirect", host: OWN, kept: true },
    { location: "/users/x", by: "set", host: OWN, kept: true },
    {
      location: "https://discord.com/channels/x",
      by: "redirect",
      host: OWN,
      kept: true,
    },
    // The request's own host, which is not config.HOST: staging serves at
    // its own host while its HOST names production.
    {
      location: "https://rpguild-staging.fly.dev/x",
      by: "redirect",
      host: "rpguild-staging.fly.dev",
      kept: true,
    },
    { location: "//evil.example/", by: "redirect", host: OWN, kept: false },
    { location: "/\\evil.example", by: "redirect", host: OWN, kept: false },
    {
      location: "https://evil.example/",
      by: "redirect",
      host: OWN,
      kept: false,
    },
    // This host from an http page, but http://evil.example/ from an https one.
    { location: "http:evil.example", by: "redirect", host: OWN, kept: false },
    // The outside list holds https URLs only.
    {
      location: "http://discord.com/channels/x",
      by: "redirect",
      host: OWN,
      kept: false,
    },
    // Browsers drop the tab and read another host.
    { location: "\t//evil.example/", by: "set", host: OWN, kept: false },
  ] as const)(
    "Location $location set by $by for Host $host: kept $kept",
    async ({ location, by, host, kept }) => {
      const res = await send(location, by, host);

      expect(res).toEqual(
        kept ? { status: 302, location } : { status: 500, location: undefined },
      );
    },
  );
});
