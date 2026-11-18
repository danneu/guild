// Password reset: POST /forgot mails a reset link, and POST /reset-password
// sets a new password with the link's token. Kept out of server/index.ts so
// tests can mount these routes without booting the app.

import Router from "@koa/router";
import { Context } from "koa";
import { hashPassword, PasswordRejected } from "../auth";
import * as belt from "../belt";
import * as config from "../config";
import * as db from "../db";
import { pool, withPgPoolTransaction } from "../db/util";
import * as emailer from "../emailer";

const router = new Router();

// What became of a reset request. ACTIVE means the account's last token is
// still good, so no mail went out.
export type ResetMailResult = "SENT" | "ACTIVE" | "SEND_FAILED";

// Mails a link only for a token db.issueResetToken returned, so one token
// lifetime sends one mail however many requests arrive at once.
export async function sendResetMail(user: {
  id: number;
  uname: string;
  email: string;
}): Promise<ResetMailResult> {
  const resetToken = await db.issueResetToken(user.id);
  if (!resetToken) return "ACTIVE";
  try {
    await emailer.sendResetTokenEmail(user.uname, user.email, resetToken.token);
  } catch {
    // sendResetTokenEmail logged it
    return "SEND_FAILED";
  }
  return "SENT";
}

//
// Forgot password page
//
router.get("/forgot", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }
  await ctx.render("forgot", {
    ctx,
    title: "Forgot Password",
  });
});

//
//
// - Required param: email
router.post("/forgot", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }

  var email = ctx.request.body.email;
  if (!email) {
    ctx.flash = { message: ["danger", "You must provide an email"] };
    ctx.response.redirect("/forgot");
    return;
  }
  // Check if it belongs to a user
  var user = await db.findUserByEmail(email);

  // Always send the same message on success and failure.
  var successMessage = "Check your email";

  // Don't let the user know if the email belongs to anyone.
  // Always look like a success
  if (!user) {
    // ctx.log.info('User not found with email: %s', email);
    ctx.flash = { message: ["success", successMessage] };
    ctx.response.redirect("/");
    return;
  }

  const result = await sendResetMail(user);
  switch (result) {
    case "ACTIVE":
      // No new mail until the last token expires
      ctx.flash = { message: ["success", successMessage] };
      ctx.response.redirect("/");
      return;
    case "SEND_FAILED":
      ctx.flash = {
        message: [
          "danger",
          "For some reason, the email failed to be sent. Email me at <mahz@roleplayerguild.com> to let me know.",
        ],
      };
      ctx.back("/");
      return;
    case "SENT":
      ctx.flash = { message: ["success", successMessage] };
      ctx.back("/");
      return;
    default: {
      const exhaustive: never = result;
      throw exhaustive;
    }
  }
});

// Password reset form
// - This form allows a user to enter a reset token and new password
// - The email from /forgot will link the user here
router.get("/reset-password", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }
  var resetToken = ctx.request.query.token;
  await ctx.render("reset_password", {
    ctx,
    resetToken: resetToken,
    title: "Reset Password with Token",
  });
});

// Params
// - token
// - password1
// - password2
router.post("/reset-password", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }
  const token = ctx.request.body.token;
  const password1 = ctx.request.body.password1;
  const password2 = ctx.request.body.password2;
  ctx.validateBody("remember-me").toBoolean();
  const rememberMe = ctx.vals["remember-me"];

  if (password1 !== password2) {
    backToResetForm(
      ctx,
      token,
      "Your new password and the new password confirmation must match",
    );
    return;
  }

  const user = await db.findUserByResetToken(token);
  if (!user) {
    backToResetForm(
      ctx,
      token,
      "Invalid reset token. Either you typed the token in wrong or the token expired.",
    );
    return;
  }

  // Hash before the transaction takes a pooled client, so bcrypt never holds
  // one. hashPassword owns the password rule. Its refusal is caught here, not
  // left to the app's error handler, which goes back by the Referer and can
  // lose the token.
  let digest: string;
  try {
    digest = await hashPassword(password1);
  } catch (err) {
    if (!(err instanceof PasswordRejected)) throw err;
    backToResetForm(ctx, token, err.message);
    return;
  }

  // Swap the password, end every grant the old one left alive (other
  // sessions included), and log the user in, all or nothing.
  const interval = rememberMe ? "1 year" : "1 day";
  const session = await withPgPoolTransaction(pool, (pgClient) =>
    db.replacePasswordTx(pgClient, user.id, digest, {
      ipAddress: ctx.request.ip,
      interval,
    }),
  );
  ctx.cookies.set("sessionId", String(session.id), {
    expires: belt.futureDate(
      new Date(),
      rememberMe ? { years: 1 } : { days: 1 },
    ),
  });

  ctx.flash = { message: ["success", "Your password was updated"] };
  return ctx.response.redirect("/");
});

// Sends a refused reset back to its form with the token the member sent, so
// they need not dig the link out of the mail again. The token rides in the
// URL, where the form reads it, and the passwords are never echoed.
function backToResetForm(ctx: Context, token: unknown, message: string) {
  ctx.flash = { message: ["danger", message] };
  ctx.redirect(
    "/reset-password?token=" +
      encodeURIComponent(typeof token === "string" ? token : ""),
  );
}

export default router;
