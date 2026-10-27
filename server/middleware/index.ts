// 3rd party
// import createDebug from 'debug'
// const debug = createDebug('app:middleware')
import _ from "lodash";
import assert from "assert";
// 1st party
import * as db from "../db";
import * as pre from "../presenters";
import * as belt from "../belt";
import { Context, Next } from "koa";

// Assoc ctx.currUser if the sessionId cookie (UUIDv4 String)
// is an active session.
export const currUser = function () {
  return async (ctx: Context, next: Next) => {
    const sessionId = ctx.cookies.get("sessionId");
    // Skip if no session id
    if (!sessionId) return next();
    // Skip if it's not a uuid
    if (!belt.isValidUuid(sessionId)) return next();

    const user = await db.findUserBySessionId(sessionId);
    ctx.currUser = pre.presentUser(user);
    ctx.state.session_id = sessionId;
    return next();
  };
};

export { flash } from "./flash";

////////////////////////////////////////////////////////////
// RATELIMITING
////////////////////////////////////////////////////////////

// Int -> Date
function postCountToMaxDate(postCount: number) {
  assert(Number.isInteger(postCount));
  // postCount to seconds of waiting
  // Now that we have the antispam classifier, 10 seconds is long enough.
  const lookup = {
    1: 10,
    2: 10,
    3: 10,
    4: 10,
    5: 10,
    6: 10,
    7: 10,
    8: 10,
    9: 10,
    10: 10,
  };
  // there's always a 1 second minimum wait to prevent dbl-posting
  const seconds = lookup[postCount] || 1;
  return new Date(Date.now() - seconds * 1000);
}

export const ratelimit = function () {
  return async (ctx: Context, next: Next) => {
    ctx.assert(ctx.currUser, 401, "You must be logged in");
    const maxDate = postCountToMaxDate(ctx.currUser.posts_count);
    try {
      await db.ratelimits.bump(ctx.currUser.id, ctx.ip, maxDate);
    } catch (err) {
      if (_.isDate(err)) {
        const msg = `Ratelimited! Since you are a new member, you must wait
          ${belt.waitLength(
            err as Date,
          )} longer before posting. The ratelimit goes away as you
          make more posts.
        `;
        ctx.check(false, msg);
        return;
      }
      throw err;
    }
    return next();
  };
};

export const methodOverride = function (
  { bodyKey, headerKey } = {
    bodyKey: "_method",
    headerKey: "x-http-method-override",
  },
) {
  return async (ctx: Context, next: Next) => {
    if (ctx.request.body && typeof ctx.request.body[bodyKey] === "string") {
      ctx.method = ctx.request.body[bodyKey].toUpperCase();
      delete ctx.request.body[bodyKey];
    } else if (typeof ctx.request.headers[headerKey] === "string") {
      ctx.method = ctx.request.headers[headerKey].toUpperCase();
    }

    await next();
  };
};
