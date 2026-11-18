// Cloudflare Turnstile, the human test. Signup asks it through
// server/signup_gate.ts#admitSignup, and login asks it over a soft limit
// through server/auth.ts#authenticate. verifyTurnstileToken is the only code
// that calls Cloudflare's siteverify.

import { z } from "zod";
import * as config from "./config";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare's documented maximum token length.
const MAX_TOKEN_LENGTH = 2048;

// The one field of siteverify's answer that this reads. A missing success,
// or one that is not a boolean, fails the parse.
const SiteverifyAnswer = z.object({ success: z.boolean() });

// Asks Cloudflare whether a token is a fresh solve from this ip. It returns
// true only when Cloudflare answers 2xx with success true. It returns false
// when Cloudflare answers success false, and without a call for a token
// Cloudflare would never accept.
//
// It throws when it could not check: a network fault, a non-2xx status, or a
// body that does not parse. So a caller can tell "could not check" from "not
// solved", and decides itself what a throw means. Neither caller admits on
// one. Callers check IS_CF_TURNSTILE_CONFIGURED first.
export async function verifyTurnstileToken(
  token: string,
  ip: string,
): Promise<boolean> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }

  const response = await fetch(SITEVERIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      secret: config.CF_TURNSTILE_SECRET,
      response: token,
      remoteip: ip,
      idempotency_key: crypto.randomUUID(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Turnstile siteverify answered HTTP ${response.status}`);
  }

  return SiteverifyAnswer.parse(await response.json()).success;
}
