import assert from "assert";
import { Context, Next } from "koa";

export default function protectCsrf(hostnameWhitelist: string[]) {
  assert(Array.isArray(hostnameWhitelist), "must provide whitelist array");
  assert(hostnameWhitelist.length > 0, "must provide at least one hostname");
  assert(
    hostnameWhitelist.every((x) => typeof x === "string"),
    "whitelist must be array of strings",
  );

  // hostnames are case-insensitive
  const lowerWhitelist = hostnameWhitelist.map((x) => x.toLowerCase());
  const whitelistSet = new Set(lowerWhitelist);
  const predicate = (requestedHostname: string): boolean => {
    const lowerHostname = requestedHostname.toLowerCase();
    if (whitelistSet.has(lowerHostname)) return true;

    // Check subdomain matches
    return lowerWhitelist.some((whitelisted) =>
      lowerHostname.endsWith("." + whitelisted),
    );
  };

  return async (ctx: Context, next: Next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(ctx.request.method)) {
      return next();
    }

    // Unlike the Referer, the Origin header will be present in
    // HTTP requests that originate from an HTTPS URL.
    const originHeader = ctx.request.headers["origin"];
    if (originHeader && URL.canParse(originHeader)) {
      const origin = new URL(originHeader);
      if (predicate(origin.hostname)) {
        return next();
      }
    }

    const refererHeader = ctx.request.headers["referer"];
    if (refererHeader && URL.canParse(refererHeader)) {
      const referer = new URL(refererHeader);
      if (predicate(referer.hostname)) {
        return next();
      }
    }

    // CSRF measure failed.
    // For now, log the issue instead of rejecting request.
    // console.warn(
    //     `csrf protection triggered for request to ${ctx.request.method} "${
    //         ctx.request.path
    //     }" with headers:\n${JSON.stringify(ctx.request.headers, null, 2)}`
    // )
    // return next()

    ctx.throw(403);
  };
}
