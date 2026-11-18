import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa from "koa";
import bouncer from "koa-bouncer";
import { describe, expect, it } from "vitest";

import { flash } from "./flash";
import { answerRefusals } from "./refusals";

// A GET that a route refuses, behind the app's own flash and refusal
// handlers. Node sees plain http, as it does behind Fly, where TLS ends
// before Node. The Host and Referer are the ones a browser would send.
async function refusedGet(headers: { host: string; referer: string }) {
  const app = new Koa();
  app.silent = true;
  app.use(flash());
  app.use(answerRefusals());
  app.use(() => {
    throw new bouncer.ValidationError("topic_id", "Invalid topic_id");
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
            path: "/search?topic_id=x",
            headers,
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

describe("answerRefusals", () => {
  // Intent: a refusal goes back by the Referer only to a page on this host.
  // Why it exists: hunt 261117-0852-063. koa 3.0.0's ctx.back redirected to
  // any Referer, so a GET that failed validation bounced the browser to the
  // other site that linked to it (CVE-2025-8129).
  // Scenario: another site links to a search with a bad topic id.
  it("sends a refusal from another site's link to /", async () => {
    const res = await refusedGet({
      host: "www.roleplayerguild.com",
      referer: "https://evil.example/landing",
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/");
  });

  // The Referer is https and Node sees http, so only the host may be compared.
  it("sends a refusal from one of the forum's pages back to it", async () => {
    const referer = "https://www.roleplayerguild.com/topics/1-hello?page=2";

    const res = await refusedGet({ host: "www.roleplayerguild.com", referer });

    expect(res.status).toBe(302);
    expect(res.location).toBe(referer);
  });
});
