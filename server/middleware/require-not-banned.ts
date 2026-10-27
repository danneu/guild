// The banned-user write gate (hunt 261026-0911-028). A banned user (role
// "banned") may read the site but may not write.
//
// This middleware is the sole enforcement point. It is fail-closed: a route
// added later is gated by default, and opening it to banned users is a
// deliberate edit to the allowlist below. The `user.role === "banned"` lines in
// server/cancan.ts only keep the UI from offering a write this gate refuses.

import { Context, Next } from "koa";

export const BANNED_MESSAGE =
  "Your account is banned. You can read the site, but you cannot post or change anything.";

// The ban predicate, in one place. The homepage reads it too, so it never
// offers a banned user a form this gate refuses.
export function isBanned(user: any): boolean {
  return user?.role === "banned";
}

// Reads are never gated.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Exact "<METHOD> <path>" matches. These are the self-service writes a banned
// user kept before the gate existed: leaving the session, recovering the
// account, and tidying their own inbox, subscriptions and profile.
const EXEMPT_ROUTES = new Set([
  // Session and account recovery
  "POST /me/logout",
  "POST /sessions",
  "POST /forgot",
  "POST /reset-password",
  // Email
  "PUT /me/email",
  "POST /api/verify-email",
  // Notifications
  "DELETE /me/notifications",
  "DELETE /me/notifications/convos",
  // Subscriptions
  "POST /me/subscriptions/mass-action",
  // PMs
  "DELETE /me/convos/trash",
  "DELETE /me/convos",
  "POST /me/convos/undelete-all",
  "POST /me/convos/move",
  // Profile
  "PUT /me/active-trophy",
  "DELETE /me/active-trophy",
  "DELETE /me/current-status",
]);

// The parameterized members of the groups above. Each segment matches
// [^/]+, and each pattern is anchored at both ends.
const EXEMPT_ROUTE_PATTERNS = [
  /^DELETE \/me\/subscriptions\/[^/]+$/,
  /^DELETE \/convos\/[^/]+$/,
  /^PUT \/convos\/[^/]+\/folder$/,
];

// Deliberately NOT allowlisted, among everything else:
// - POST /users, though the email gate allows it: a banned session must log
//   out before it registers again.
// - DELETE /api/me/notifications/:id: DELETE_NOTIFICATION already refused
//   banned users, and DELETE /me/notifications still clears them all.
// - DELETE /me/ratings/:postId: a banned user cannot rate, so has nothing to
//   undo.
export function isBanGateExemptRoute({
  method,
  path,
}: {
  method: string;
  path: string;
}): boolean {
  // Koa uppercases ctx.method, and methodOverride uppercases what it rewrites
  // from _method, so both arrive uppercase and no lowercasing happens here.
  if (SAFE_METHODS.has(method)) return true;

  const route = `${method} ${path}`;
  if (EXEMPT_ROUTES.has(route)) return true;
  return EXEMPT_ROUTE_PATTERNS.some((re) => re.test(route));
}

export function requireNotBanned() {
  return async (ctx: Context, next: Next) => {
    if (!isBanned(ctx.currUser)) return next();

    // ctx.method is the value methodOverride already rewrote from _method, and
    // the same value the router will dispatch on.
    if (isBanGateExemptRoute({ method: ctx.method, path: ctx.path })) {
      return next();
    }

    // An XHR has no redirect to follow, so tell it plainly.
    if (ctx.path.startsWith("/api/")) {
      ctx.throw(403, BANNED_MESSAGE);
    }

    // Mounted before nunjucks and bouncer, so ctx.back does not exist yet, and
    // there is no banned page. The homepage shows the flash.
    ctx.flash = { message: ["danger", BANNED_MESSAGE] };
    ctx.redirect("/");
  };
}
