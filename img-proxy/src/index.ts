/// <reference types="../worker-configuration" />

import handleGetProxy from "./routes/get-proxy";
import type { Env } from "./types";

const router: Record<
  string,
  Record<
    string,
    (
      url: URL,
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ) => Promise<Response>
  >
> = {
  GET: {
    "/": async () => {
      return new Response(
        `<!doctype html>
        <h1>Guild's image proxy</h1>
        <p>Usage: <code>/proxy?url=https%3A%2F%2Fexample.com%2Fimage.jpg</code></p>
        <p><strong>Note:</strong> The URL parameter must be URL encoded.</p>
        `,
        {
          headers: {
            "Content-Type": "text/html",
          },
        },
      );
    },
    "/proxy": handleGetProxy,
  },
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const handler = router[request.method]?.[url.pathname];
    if (!handler) {
      return new Response("Not found", { status: 404 });
    }
    return handler(url, request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
