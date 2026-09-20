// The email confirmation write gate -- plan/2026-08-11-1613.
//
// This middleware is the sole enforcement point. It is fail-closed: a route
// added later is gated by default, and opening it up is a deliberate edit to
// the allowlist below.

import { Context, Next } from "koa";

export const EMAIL_GATE_MESSAGE =
  "Please confirm your email address before posting. We sent you a confirmation link.";

// The gate predicate, in one place. The site-wide banner and the wall page read
// it too, so a template can never drift from what the middleware enforces.
//
// A user is past the gate if they confirmed an address (email_verified_at) or
// if they are excused from the gate entirely (email_gate_exempt_at): every
// pre-existing account at migration time, every account created while email is
// unconfigured, and anyone staff excused during a mail outage.
export function isEmailGateSatisfied(user: any): boolean {
  // Guests are not gated. Everything a guest can do is either a read or a
  // route on the allowlist below (log in, register, reset a password).
  if (!user) return true;
  return Boolean(user.email_verified_at || user.email_gate_exempt_at);
}

// Whether this account still has an address to confirm, which is a strictly
// narrower question than whether it is past the write gate.
//
// An exemption is not a confirmation: a grandfathered legacy account carries
// email_gate_exempt_at with no email_verified_at, so it writes freely and yet
// has never confirmed anything. It must still be offered a way to confirm --
// otherwise it silently drops out of PM notification mail once that mail keys
// on email_verified_at, and constraint 1 of plan/2026-08-11-1613 ("nobody can
// be locked out with no recovery path") is violated for confirmation itself.
//
// Keyed on email_verified_at and NOT on the presence of a pending token row:
// an account that has never been sent a link has no row, and that is exactly
// the account that most needs the offer.
export function needsEmailConfirmation(user: any): boolean {
  if (!user) return false;
  return !user.email_verified_at;
}

// Reads are never gated.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Exact "<METHOD> <path>" matches. Every entry here is either a route a gated
// user needs to escape the gate, or a route whose absence would lock them out.
const EXEMPT_ROUTES = new Set([
  // Session management. Registration sets a 1-year cookie, so a gated user is
  // stuck with it unless these work.
  "POST /me/logout",
  "POST /sessions",
  // Registering while holding a stale unverified cookie. Turnstile-protected.
  "POST /users",
  // Lockout fix: "I forgot which password I typed" lands here while gated.
  // Already rate-limited by the active-reset-token check.
  "POST /forgot",
  // Lockout fix: this creates a session, so blocking it is a hard stop.
  "POST /reset-password",
  // Escaping the gate: resend the link, or correct the address it goes to.
  "POST /api/verify-email",
  "PUT /me/email",
  // Registration sends a welcome PM, so a gated user lands with a notification
  // badge they would otherwise have no way to clear.
  "DELETE /me/notifications",
  "DELETE /me/notifications/convos",
]);

// The parameterized member of the notification group. Blocking it would
// hard-403 an XHR with no UI feedback at all.
const EXEMPT_ROUTE_PATTERNS = [/^DELETE \/api\/me\/notifications\/[^/]+$/];

// Deliberately NOT allowlisted: everything else, avatar upload included.
export function isEmailGateExemptRoute({
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

export function requireConfirmedEmail() {
  return async (ctx: Context, next: Next) => {
    if (!ctx.currUser) return next();
    if (isEmailGateSatisfied(ctx.currUser)) return next();

    // ctx.method is the value methodOverride already rewrote from _method, and
    // the same value the router will dispatch on, so a POST carrying
    // _method=GET reaches only the GET handler. There is no bypass here.
    if (isEmailGateExemptRoute({ method: ctx.method, path: ctx.path })) {
      return next();
    }

    // An XHR has no redirect to follow, so tell it plainly.
    if (ctx.path.startsWith("/api/")) {
      ctx.throw(403, EMAIL_GATE_MESSAGE);
    }

    // This middleware is mounted before nunjucks and before bouncer, so
    // ctx.render and ctx.back do not exist yet. That is deliberate: the gate
    // must not depend on the view layer, and a plain redirect to the wall page
    // is the right response regardless of where the request came from.
    ctx.flash = { message: ["danger", EMAIL_GATE_MESSAGE] };
    ctx.redirect("/confirm-email");
  };
}
