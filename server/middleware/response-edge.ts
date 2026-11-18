// Owns the rules for what a response may carry, checked once on the final
// state of every response:
// - A Location keeps the browser on the request's own host, or is an https URL
//   on OUTSIDE_HOSTS. Any other answers 500. It reads the header, so it judges
//   every way one is set: ctx.redirect, ctx.back, ctx.set, or middleware that
//   builds one from the path. It compares with the raw Host header, never
//   config.HOST, which names production on staging.
// - JSON leaves only through server/api_json.ts#sendJson. Any other body Koa
//   would JSON-encode (a db row, say) answers 500 instead of leaking columns.
// - HTML leaves only through ctx.render. Koa types any string body that starts
//   with "<" as text/html, and a handler can also set an html type by hand, so
//   member text (a post's raw markup, say) could otherwise run as script on the
//   forum origin. Every other HTML-typed body goes out as text/plain instead,
//   so a hand-built page shows its source. New HTML pages belong in views/.

import { Context, Next } from "koa";

import { assertJsonFromOwner } from "../api_json";
import { staysOnHost } from "../request_host";

// The hosts a server-built redirect may send the browser to, besides the
// request's own, over https only: the Discord join's authorize and channel
// pages. A target the request supplies never gets this list; routes judge one
// with staysOnHost alone, so a form cannot name these hosts either.
const OUTSIDE_HOSTS = new Set(["discord.com"]);

// Throws for a Location that would take the browser off this site, unless it is
// an https URL on OUTSIDE_HOSTS. An answer of 500 fails closed, and shows at
// once the code that built the target. A route that redirects to a target from
// the request checks it with staysOnHost first and falls back to its own page,
// since its write has already gone through.
function assertLocationAllowed(ctx: Context): void {
  const location = ctx.res.getHeader("Location");
  if (location === undefined) return;
  if (staysOnHost(location, ctx.req.headers.host)) return;
  if (namesOutsideHost(location)) return;
  throw new Error(
    `${ctx.method} ${ctx.path} set Location ${JSON.stringify(location)}, ` +
      "which leaves the site. Redirect to a path, check a target from the " +
      "request with server/request_host.ts#staysOnHost, or add an outside " +
      "host to server/middleware/response-edge.ts#OUTSIDE_HOSTS.",
  );
}

// An absolute https URL on OUTSIDE_HOSTS. A relative value is never one: it
// resolves against this site.
function namesOutsideHost(value: unknown): boolean {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && OUTSIDE_HOSTS.has(url.host);
}

// The body each request's last ctx.render produced. A body that is not this
// exact value did not come from a view.
const rendered = new WeakMap<Context, string>();

// Mounted as the first app.use so it sees the final headers and body of every
// response, whoever set them. A refused Location or a JSON body that sendJson
// did not build throws here, after the handler has finished, and Koa's onerror
// answers 500 and drops every header the handler set. Only string and Buffer
// bodies are retyped: streams come from file sends of repo files, never member
// text. A thrown error skips this, but Koa's onerror drops the handler's
// headers and answers errors as text anyway.
export function responseEdge() {
  return async (ctx: Context, next: Next) => {
    await next();
    assertLocationAllowed(ctx);
    assertJsonFromOwner(ctx);
    const body = ctx.body;
    if (typeof body !== "string" && !Buffer.isBuffer(body)) return;
    if (!ctx.response.is("html")) return;
    if (rendered.get(ctx) === body) return;
    ctx.type = "text/plain; charset=utf-8";
  };
}

// Wraps the koa-nunjucks-render middleware so each ctx.render records the body
// it produced. It takes that middleware as its argument because the library
// assigns a fresh ctx.render on every request; wrapping it is the only order
// in which the recorder always sees that function.
export function trustRendered(
  renderMiddleware: (ctx: Context, next: Next) => Promise<unknown>,
) {
  return (ctx: Context, next: Next) =>
    renderMiddleware(ctx, () => {
      const render = ctx.render;
      ctx.render = async (view: string, locals?: object) => {
        await render(view, locals);
        if (typeof ctx.body === "string") rendered.set(ctx, ctx.body);
      };
      return next();
    });
}
