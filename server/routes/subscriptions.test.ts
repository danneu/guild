import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  subscriptions: { unsubscribeFromTopic: vi.fn(async () => {}) },
}));

import * as cancan from "../cancan";
import * as db from "../db";
import { responseEdge } from "../middleware/response-edge";
import router from "./subscriptions";

const alice = { id: 1, uname: "Alice", slug: "alice", role: "member" };

beforeEach(() => {
  vi.clearAllMocks();
});

// A bare Koa app with the response edge first, as in server/index.ts, and
// only what the route reads from ctx. The authz shim mirrors the one there.
async function unsubscribe(redirectTo: string) {
  const app = new Koa();
  app.silent = true;
  app.use(responseEdge());
  app.use((ctx: Context, next: Next) => {
    ctx.currUser = { ...alice };
    (ctx.request as any).body = {};
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    return next();
  });
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .request(
          {
            host: "127.0.0.1",
            port,
            method: "DELETE",
            path: `/me/subscriptions/42?redirectTo=${encodeURIComponent(redirectTo)}`,
            headers: { host: "www.roleplayerguild.com" },
            agent: false,
          },
          resolve,
        )
        .on("error", reject)
        .end();
    });
    res.resume();
    return { status: res.statusCode, location: res.headers.location };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("DELETE /me/subscriptions/:topicSlug", () => {
  // Intent: a return target from the request that would leave this host sends
  // the member to the route's default page, after the unsubscribe went
  // through.
  // Why it exists: hunt 261117-0852-032. The route redirected to any
  // redirectTo. The response edge now answers 500 for an off-site Location,
  // which would report a failed write that in fact went through. Discord is
  // on the edge's list for server-built redirects, but a request may not name
  // it.
  // Scenario: Alice unsubscribes through a form whose redirectTo was changed.
  it.each(["https://evil.example/", "https://discord.com/channels/x"])(
    "sends redirectTo %j to /me/subscriptions",
    async (redirectTo) => {
      const res = await unsubscribe(redirectTo);

      expect(db.subscriptions.unsubscribeFromTopic).toHaveBeenCalledWith(
        alice.id,
        42,
      );
      expect(res).toEqual({ status: 302, location: "/me/subscriptions" });
    },
  );
});
