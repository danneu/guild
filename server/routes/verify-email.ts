import Router from "@koa/router";
import * as db from "../db";
import assert from "assert";
import * as belt from "../belt";
import crypto from "crypto";
import * as config from "../config";
import * as emailer from "../emailer";
import { Context } from "koa";

const router = new Router();

function createToken(secret, email) {
  assert(typeof email === "string");
  assert(typeof secret === "string");
  const hmac = crypto.createHmac("sha512", secret);
  const data = hmac.update(email);
  return data.digest("hex");
}

// For UX, this is clickable from anywhere. You don't need to ensure you're opening it in the browser
// that you're logged into the guild on. Not sure of the security implications of that tho.
router.get("/verify-email", async (ctx: Context) => {
  // User doesn't have to be logged in
  const { token, email } = ctx.request.query;
  ctx.assert(typeof token === "string", 400, "expected token field");
  ctx.assert(typeof email === "string", 400, "expected email field");

  if (token !== createToken(config.SECRET, email)) {
    ctx.flash = { message: ["danger", "Invalid token."] };
    ctx.redirect(ctx.currUser ? "/me/edit" : "/");
    return;
  }

  if (ctx.currUser) {
    // User echoes back email to ensure they didn't change their email during the trip.
    if (ctx.currUser.email !== email) {
      ctx.flash = {
        message: [
          "danger",
          "Given email address does not match the one on file.",
        ],
      };
      ctx.redirect("/me/edit");
      return;
    }
    await db.users.updateUser(ctx.currUser.id, { email_verified: true });
  } else {
    // Not logged in, so load user from email
    const user = await db.users.getUserByEmail(email);
    ctx.assert(user, 404);

    // Since we're also using this as a one-time-use login link, bail if user is
    // already verified
    if (user.email_verified) {
      ctx.flash = { message: ["info", "Your email is already verified."] };
      ctx.redirect("/");
      return;
    }
    await db.users.updateUser(user.id, { email_verified: true });
  }

  ctx.flash = { message: ["success", "Email address verified."] };
  ctx.redirect(ctx.currUser ? "/me/edit" : "/");
});

// mapping of user id -> Date of email send
const sent = new Map<number, Date>();

// Generates an email verification token AND sends verification email.
router.post("/api/verify-email", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);

  const prev = sent.get(ctx.currUser.id);
  if (!prev || belt.isOlderThan(prev, { seconds: 60 })) {
    const token = createToken(config.SECRET, ctx.currUser.email);
    await emailer.sendEmailVerificationLinkEmail({
      toUname: ctx.currUser.uname,
      toEmail: ctx.currUser.email,
      token,
    });
    sent.set(ctx.currUser.id, new Date());
    ctx.status = 201;
    return;
  }

  ctx.status = 429;
});

export default router;
