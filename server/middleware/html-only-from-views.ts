// Owns one rule at the response edge: HTML leaves only through ctx.render.
// Koa types any string body that starts with "<" as text/html, and a handler
// can also set an html type by hand, so member text (a post's raw markup, say)
// could otherwise run as script on the forum origin. Every other HTML-typed
// body goes out as text/plain instead, so a hand-built page shows its source.
// New HTML pages belong in views/.

import { Context, Next } from "koa";

// The body each request's last ctx.render produced. A body that is not this
// exact value did not come from a view.
const rendered = new WeakMap<Context, string>();

// Mounted as the first app.use so it sees the final body of every response,
// whoever set it. Only string and Buffer bodies are retyped: streams come from
// file sends of repo files, never member text. A thrown error skips this, but
// Koa's onerror answers errors as text anyway.
export function retypeUnrenderedHtml() {
  return async (ctx: Context, next: Next) => {
    await next();
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
