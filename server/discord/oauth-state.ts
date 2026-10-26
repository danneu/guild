// The Discord OAuth state: the only code that touches the oauth2_state cookie
// or reads the callback query. It runs the whole callback, so a code reaches
// the route only after its state matched, and every exit clears the state.
// It imports no config, so tests can load it without Discord settings.

import crypto from "node:crypto";
import type { ParsedUrlQuery } from "node:querystring";
import type { Context } from "koa";

const STATE_COOKIE = "oauth2_state";

// Caps how long a state lives if its clear never reaches the browser. It
// leaves room for Discord's consent page.
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Starts a flow: stores a fresh random state in the browser and returns it for
 * the authorize URL. sameSite must stay "lax", because the return from
 * discord.com is a cross-site top-level GET and "strict" would drop the
 * cookie. There is no secure option: behind Fly, Koa sees plain http, and
 * cookies 0.9.1 throws on secure: true there.
 */
export function issueOAuthState(ctx: Context): string {
  const state = crypto.randomBytes(32).toString("base64url");
  ctx.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: STATE_MAX_AGE_MS,
  });
  return state;
}

export type CallbackResult = { ok: true; code: string } | { ok: false };

/**
 * Decides whether a callback may redeem its code. Only a callback whose state
 * matches the browser's cookie yields one. A missing, empty or repeated value
 * on either side never matches, since Koa parses a repeated key as an array.
 */
export function parseCallback(
  cookieState: string | undefined,
  query: ParsedUrlQuery,
): CallbackResult {
  const { state, code } = query;
  if (!isNonEmpty(cookieState) || !isNonEmpty(state) || !isNonEmpty(code)) {
    return { ok: false };
  }
  // Digests have one length, so timingSafeEqual cannot throw on states whose
  // byte lengths differ.
  if (!crypto.timingSafeEqual(sha256(cookieState), sha256(state))) {
    return { ok: false };
  }
  return { ok: true, code };
}

/**
 * Runs a callback request end to end. It clears the state first, so the state
 * dies with this request whatever happens next. `redeem` gets the code only
 * after the state matched, and returns where to send the user. No error
 * leaves this function: Koa's error handler removes every response header,
 * the clearing Set-Cookie included.
 */
export async function runOAuthCallback(
  ctx: Context,
  redeem: (code: string) => Promise<string>,
): Promise<void> {
  const cookieState = ctx.cookies.get(STATE_COOKIE);
  ctx.cookies.set(STATE_COOKIE, null);

  const result = parseCallback(cookieState, ctx.query);
  if (!result.ok) {
    ctx.status = 403;
    ctx.body =
      "This Discord sign-in expired, was cancelled, or did not start here. Start again from the Guild.";
    return;
  }

  let location: string;
  try {
    location = await redeem(result.code);
  } catch (err) {
    console.error("Discord OAuth callback failed:", err);
    ctx.status = 500;
    ctx.body = "Something went wrong while joining Discord. Please try again.";
    return;
  }
  ctx.redirect(location);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}
