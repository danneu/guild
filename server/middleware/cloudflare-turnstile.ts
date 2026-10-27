// This is the demo secret key. In production, we recommend
// you store your secret key(s) safely.

import { Context, Next } from "koa";
import { z } from "zod";
import * as config from "../config";

const BodySchema = z
  .object({
    "cf-turnstile-response": z.string({
      message: "You must attempt the human test",
    }),
  })
  .passthrough();

// Cloudflare's documented maximum token length.
const MAX_TOKEN_LENGTH = 2048;

// Asks Cloudflare whether a Turnstile token is a fresh solve from this ip.
// Shared by the registration middleware below and the login challenge in
// server/auth.ts#authenticate. Callers check IS_CF_TURNSTILE_CONFIGURED first.
export async function verifyTurnstileToken(
  token: string,
  ip: string,
): Promise<boolean> {
  if (token.length > MAX_TOKEN_LENGTH) {
    return false;
  }
  const idempotencyKey = crypto.randomUUID();
  const url = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      secret: config.CF_TURNSTILE_SECRET,
      response: token,
      remoteip: ip,
      idempotency_key: idempotencyKey,
    }),
  });

  const outcome = (await response.json()) as TurnstileOutcome;
  return outcome.success;
}

export default async function checkCloudflareTurnstile(
  ctx: Context,
  next: Next,
) {
  if (!config.IS_CF_TURNSTILE_CONFIGURED) {
    return next();
  }

  const body = BodySchema.parse(ctx.request.body);

  // The IP-resolution middleware runs first, so ctx.request.ip is the trusted
  // value rather than the raw, spoofable cf-connecting-ip header.
  const solved = await verifyTurnstileToken(
    body["cf-turnstile-response"],
    ctx.request.ip,
  );
  if (!solved) {
    ctx.flash = {
      message: ["danger", "You failed the human test"],
      params: ctx.request.body,
    };
    ctx.back("/");
    return;
  }

  return next();
}

type TurnstileOutcome = {
  success: boolean;
  "error-codes": string[];
  challenge_ts: string;
  hostname: string;
  action: string;
  cdata: string;
  idempotency_key: string;
  metadata: { interactive: boolean };
};
