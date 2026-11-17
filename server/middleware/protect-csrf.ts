// The CSRF gate for every write. SameSite=Lax keeps a member's session cookie
// off cross-site writes, but the writes that need no session (login, signup
// and the password-reset request) have only this gate. It also refuses pages
// on other subdomains, such as the upload hosts, whose writes Lax lets through
// because they are same-site.
//
// The decision is the pure shouldRejectCrossSite; the middleware is a thin
// shell around it.

import { Context, Next } from "koa";
import { namesRequestHost } from "../request_host";

// Reads never change state, so they are never judged.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The Sec-Fetch-Site values for a request from one of this origin's own
// pages, or from the user (a bookmark or a typed URL).
const OWN_SITE = new Set(["same-origin", "none"]);

// What the gate reads from a request. Each header is its raw value, and an
// empty one counts as absent.
export type WriteSource = {
  // ctx.method after methodOverride: the method the router dispatches on.
  method: string;
  host: string | undefined;
  secFetchSite: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
};

// True for a write that another site's page sent. Go 1.25's
// http.CrossOriginProtection also checks Sec-Fetch-Site first and compares
// Origin with Host only when it is absent. Unlike Go, Referer stands in for a
// missing Origin, and a write with neither is refused, as this gate always
// has: no client of this app sends one.
export function shouldRejectCrossSite(req: WriteSource): boolean {
  if (SAFE_METHODS.has(req.method)) return false;

  // The browser computes Sec-Fetch-Site, and a page cannot set it. A proxy
  // could strip or rewrite it, so this trusts Cloudflare and Fly to pass it
  // through unchanged; scripts/csrf-probe.ts checks that after a deploy.
  if (req.secFetchSite) return !OWN_SITE.has(req.secFetchSite);

  // The fallback, for browsers that send no Sec-Fetch-Site: Safari before
  // 16.4, Firefox before 90, and any page served over plain http from a host
  // other than localhost. Referer stands in only when Origin is absent, so
  // Origin "null" is refused. This trusts that the Host reaching Node is the
  // one the browser sent; scripts/csrf-probe.ts checks that too.
  // Residual risk: TLS ends before Node, so the Host cannot tell http from
  // https, and a plain-http page on this host passes as this origin.
  const source = req.origin || req.referer;
  if (!source || !URL.canParse(source)) return true;
  return !namesRequestHost(new URL(source), req.host);
}

// Mounted in server/index.ts after methodOverride and before every router;
// protect-csrf.test.ts checks that order in the source.
export default function protectCsrf() {
  return async (ctx: Context, next: Next) => {
    // Raw headers: ctx.host can come from X-Forwarded-Host, and
    // ctx.get("referer") prefers a nonstandard Referrer header.
    const headers = ctx.req.headers;
    const reject = shouldRejectCrossSite({
      method: ctx.method,
      host: headers.host,
      secFetchSite: headers["sec-fetch-site"],
      origin: headers.origin,
      referer: headers.referer,
    });
    if (reject) ctx.throw(403);
    return next();
  };
}
