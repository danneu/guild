// The app-wide body parser, and the only file that imports koa-body
// (server/parser-owners.test.ts holds that). Multipart stays off here:
// uploads are parsed by server/upload.ts, after the route has authorized them.

import { koaBody } from "koa-body";
import { Context, Next } from "koa";

/**
 * Parses JSON, urlencoded and text bodies. Every other body, multipart
 * included, is left unread, and ctx.request.body is {} for it, so a route sees
 * missing fields rather than an undefined body.
 */
export function bodyParser() {
  const parse = koaBody({
    multipart: false,
    // Max payload size allowed in request form body
    // Defaults to '56kb'
    // CloudFlare limits to 100mb max
    formLimit: "25mb",
  });
  return (ctx: Context, next: Next) =>
    parse(ctx, () => {
      ctx.request.body ??= {};
      return next();
    });
}
