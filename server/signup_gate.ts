// The gate in front of account creation. admitSignup is the only maker of a
// SignupPermit, and server/db/accounts.ts#createUserWithSession requires one.
// So a new account path that skips this gate fails `pnpm run check`. See
// docs/agents/auth.md#signup.

import * as config from "./config";
import * as db from "./db";
import { verifyTurnstileToken } from "./turnstile";

// Not exported, so no other module can write a SignupPermit without a cast.
const permitBrand = Symbol("SignupPermit");

// Proof that a request passed admitSignup. It is not spent when used: code
// that holds one can pass it again. So it proves that the gate ran, not that
// each account had its own solve.
export type SignupPermit = { readonly [permitBrand]: true };

// What admitSignup decided. Only ADMITTED carries a permit.
export type SignupGate =
  | { type: "ADMITTED"; permit: SignupPermit }
  // The REGISTRATION_ENABLED keyval is off.
  | { type: "CLOSED" }
  // The token is missing or not a string, or Cloudflare refused it.
  | { type: "UNSOLVED" }
  // Cloudflare could not be asked, or its answer did not parse.
  | { type: "UNCHECKED" };

// Decides whether a signup request may create an account. It reads the
// registration switch before it asks Cloudflare, so a closed signup costs no
// call. With Turnstile unconfigured, as in local dev, it admits.
export async function admitSignup(
  token: unknown,
  ip: string,
): Promise<SignupGate> {
  if (!(await db.keyvals.getValueByKey("REGISTRATION_ENABLED"))) {
    return { type: "CLOSED" };
  }
  if (!config.IS_CF_TURNSTILE_CONFIGURED) {
    return admitted();
  }
  if (typeof token !== "string") {
    return { type: "UNSOLVED" };
  }

  let solved: boolean;
  try {
    solved = await verifyTurnstileToken(token, ip);
  } catch (err) {
    // Fails closed: a Cloudflare fault never admits.
    console.error("signup: Turnstile verification failed:", err);
    return { type: "UNCHECKED" };
  }
  return solved ? admitted() : { type: "UNSOLVED" };
}

function admitted(): SignupGate {
  return { type: "ADMITTED", permit: { [permitBrand]: true } };
}
