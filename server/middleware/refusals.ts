// The app-wide answer to a refusal that a route lets escape: a zod or
// koa-bouncer validation error, or a MemberRefusal (server/member_refusal.ts).
// server/index.ts mounts it after bouncer and before every router. It has its
// own module so route tests mount the real one, not a copy.

import { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { z } from "zod";
import { MemberRefusal } from "../member_refusal";
import { FlashParams, FORM_REFILL_FIELDS } from "./flash";

export function answerRefusals() {
  return async (ctx: Context, next: Next) => {
    try {
      await next();
    } catch (ex: any) {
      // Catch any ZodErrors that bubble up and return a flash message
      if (ex instanceof z.ZodError) {
        // Adding the path is nice if I forget to set a message: `Required (username)`
        // FIXME: But if I do add a custom message, then it's weird: `You must set a tag (tag)`
        const message = ex.issues[0]
          ? `${ex.issues[0].message} (${ex.issues[0].path.join(".")})`
          : ex.message;
        ctx.flash = {
          message: ["danger", message],
          // FIXME: This breaks if body is bigger than ~4kb cookie size limit
          // i.e. large posts, large bodies of text
          params: FlashParams.pick(ctx.request.body, FORM_REFILL_FIELDS),
        };
        ctx.back("/");
        return;
      }
      if (ex instanceof bouncer.ValidationError) {
        ctx.flash = {
          message: ["danger", ex.message || "Validation error"],
          // FIXME: This breaks if body is bigger than ~4kb cookie size limit
          // i.e. large posts, large bodies of text
          params: FlashParams.pick(ctx.request.body, FORM_REFILL_FIELDS),
        };
        ctx.back("/");
        return;
      }
      // An XHR has no redirect to follow, so it gets a 400 with the reason, as
      // the ban gate in server/middleware/require-not-banned.ts answers one. A
      // form post gets the reason as a flash, and its form back only when the
      // refusal says the form fits in the flash cookie.
      if (ex instanceof MemberRefusal) {
        if (ctx.path.startsWith("/api/")) ctx.throw(400, ex.message);
        ctx.flash = ex.echoForm
          ? {
              message: ["danger", ex.message],
              params: FlashParams.pick(ctx.request.body, FORM_REFILL_FIELDS),
            }
          : { message: ["danger", ex.message] };
        ctx.back("/");
        return;
      }
      throw ex;
    }
  };
}
