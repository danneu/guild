import { Context, Next } from "koa";

// A run of slashes and backslashes at the start of a path. Browsers read a
// Location that starts with two of them, in any mix, as another host.
const LEADING_SLASHES = /^[/\\]+/;

// Redirects a GET or HEAD for a path that ends in a slash, other than "/", to
// the same path without that slash: /users/x/ answers 301 /users/x. The router
// matches either form, so this keeps one canonical URL for old links and
// search engines.
//
// The target is built so that it always names a path on this site: one "/",
// then the path with its last slash cut and its leading slashes and
// backslashes stripped. Cutting only the last slash would send //evil.example/
// to //evil.example, another host (hunt 261117-0852-054).
//
// It judges ctx.method, the method the router dispatches on. Other methods go
// on to the router, since a 301 makes a browser drop a POST body.
export function trailingSlash() {
  return async (ctx: Context, next: Next) => {
    const { path, search } = ctx.request;
    const redirects =
      (ctx.method === "GET" || ctx.method === "HEAD") &&
      path.length > 1 &&
      path.endsWith("/");
    if (!redirects) return next();

    ctx.status = 301;
    ctx.redirect("/" + path.slice(0, -1).replace(LEADING_SLASHES, "") + search);
    return;
  };
}
