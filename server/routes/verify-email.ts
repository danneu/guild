import Router from "@koa/router";
import * as db from "../db";
import * as belt from "../belt";
import * as config from "../config";
import * as emailer from "../emailer";
import { isEmailGateSatisfied } from "../middleware/require-confirmed-email";
import { Context } from "koa";

const router = new Router();

// Email confirmation -- plan/2026-08-11-1613.
//
// The old scheme mailed a deterministic HMAC-SHA512(SECRET, email) that never
// expired and was replayable forever. It is gone: links are now single-use
// uuids that expire, and the address they confirm rides on the token row.

const THROTTLE_MESSAGE =
  "We just sent you a confirmation link. Please wait a minute before asking for another one.";

// Where a user belongs after acting on their confirmation state.
function afterEmailAction(ctx: Context): string {
  if (!ctx.currUser) return "/login";
  return isEmailGateSatisfied(ctx.currUser)
    ? `/users/${ctx.currUser.slug}/edit#email`
    : "/confirm-email";
}

async function sendVerificationLink(
  row: { email: string; token: string },
  uname: string,
) {
  await emailer.sendEmailVerificationLinkEmail({
    toUname: uname,
    toEmail: row.email,
    token: row.token,
  });
}

////////////////////////////////////////////////////////////

// The wall page: what a gated user is redirected to.
router.get("/confirm-email", async (ctx: Context) => {
  if (!ctx.currUser) {
    ctx.redirect("/login");
    return;
  }

  if (isEmailGateSatisfied(ctx.currUser)) {
    ctx.redirect(`/users/${ctx.currUser.slug}/edit#email`);
    return;
  }

  // Base table, not the active_* view: an expired link still tells the user
  // which address they are waiting on (plan/2026-08-11-1613/I3).
  const pending = await db.emailVerification.findPendingEmailVerification(
    ctx.currUser.id,
  );

  await ctx.render("confirm_email", {
    ctx,
    title: "Confirm your email address",
    pendingEmail: pending ? pending.email : ctx.currUser.email,
  });
});

////////////////////////////////////////////////////////////

// Clicking the link. Deliberately not a login: the link is not a bearer
// credential, and password reset already covers account recovery.
router.get("/verify-email", async (ctx: Context) => {
  const { token } = ctx.request.query;

  if (typeof token !== "string" || !belt.isValidUuid(token)) {
    ctx.flash = {
      message: ["danger", "That confirmation link is not valid."],
    };
    ctx.redirect(ctx.currUser ? "/confirm-email" : "/login");
    return;
  }

  const result =
    await db.emailVerification.consumeEmailVerificationToken(token);

  switch (result.type) {
    case "INVALID":
      ctx.flash = {
        message: [
          "danger",
          "That confirmation link has expired or has already been used. Request a new one below.",
        ],
      };
      ctx.redirect(ctx.currUser ? "/confirm-email" : "/login");
      return;
    case "EMAIL_TAKEN":
      ctx.flash = {
        message: [
          "danger",
          "That email address now belongs to another account, so it could not be confirmed. The address on your account is unchanged. Enter a different address to confirm.",
        ],
      };
      ctx.redirect(ctx.currUser ? "/confirm-email" : "/login");
      return;
    case "OK":
      ctx.flash = {
        message: ["success", "Email address confirmed."],
      };
      // ctx.currUser was loaded before the swap, so it still carries the old
      // stamps. Sending them home re-reads the row.
      ctx.redirect(ctx.currUser ? "/" : "/login");
      return;
  }
});

////////////////////////////////////////////////////////////

// Resend (AJAX). Never chooses a destination: it renews the address already on
// the row, and only falls back to the account's address when no row exists.
router.post("/api/verify-email", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);
  ctx.assert(config.IS_EMAIL_CONFIGURED, 404);

  const row = await db.emailVerification.resendEmailVerification(
    ctx.currUser.id,
    ctx.currUser.email,
  );

  // Nothing replaced means the previous issuance is younger than the throttle
  // window. The check lives in SQL, so it survives a deploy and holds across
  // processes -- unlike the in-memory Map this replaces.
  if (!row) {
    ctx.status = 429;
    return;
  }

  await sendVerificationLink(row, ctx.currUser.uname);
  ctx.status = 201;
});

////////////////////////////////////////////////////////////

// Change the address you are confirming.
//
// This is the only route that stages an address, and it never touches
// users.email: confirmation is the sole writer of that column
// (plan/2026-08-11-1613/I2), so a typo can never lock an established member
// out -- it simply never confirms.
router.put("/me/email", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 403);

  // Accounts created while email is unconfigured are exempt from the gate, so
  // there is nothing here to confirm and no way to mail a link.
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }

  ctx
    .validateBody("email")
    .isString("Email required")
    .isEmail("Invalid email address");
  const email = ctx.vals.email.trim();

  // unique_email is on lower(email), so a case-only edit would stage an address
  // the user already holds. Compare case-insensitively, but never lowercase on
  // write: that would silently rewrite stored addresses.
  if (email.toLowerCase() === ctx.currUser.email.toLowerCase()) {
    ctx.flash = {
      message: ["info", "That is already the address on your account."],
    };
    ctx.redirect(afterEmailAction(ctx));
    return;
  }

  const row = await db.emailVerification.stageEmailVerification(
    ctx.currUser.id,
    email,
  );

  if (!row) {
    ctx.flash = { message: ["warning", THROTTLE_MESSAGE] };
    ctx.redirect(afterEmailAction(ctx));
    return;
  }

  await sendVerificationLink(row, ctx.currUser.uname);

  ctx.flash = {
    message: [
      "success",
      `We sent a confirmation link to ${row.email}. Your account keeps its current address until you click it.`,
    ],
  };
  ctx.redirect(afterEmailAction(ctx));
});

export default router;
