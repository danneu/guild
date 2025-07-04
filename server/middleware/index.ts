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

// Expose req.flash (getter) and res.flash = _ (setter)
// Flash data persists in user's sessions until the next ~successful response
export function flash(cookieName = "flash") {
  return async (ctx: Context, next: Next) => {
    let data = Object.create(null);

    if (ctx.cookies.get(cookieName)) {
      try {
        data = JSON.parse(
          decodeURIComponent(ctx.cookies.get(cookieName) ?? ""),
        );
      } catch (err) {
        // If cookie had a value but was not JSON, then trash the cookie
        ctx.cookies.set(cookieName, null);
      }
    }

    Object.defineProperty(ctx, "flash", {
      enumerable: true,
      get: () => {
        return data;
      },
      set: (val) => {
        const encodedVal = encodeURIComponent(JSON.stringify(val));
        ctx.cookies.set(cookieName, encodedVal, {
          // Expire flash cookie in 10 seconds to avoid stale cookie
          maxAge: 10 * 1000,
        });
      },
    });

    await next();

    // Clear flash cookie on successful response *and* if the cookie is
    // not already cleared
    if (
      ctx.response.status < 300 &&
      ctx.cookies.get(cookieName) !== undefined
    ) {
      ctx.cookies.set(cookieName, null);
    }
  };
}

////////////////////////////////////////////////////////////
// RATELIMITING
////////////////////////////////////////////////////////////

// Int -> Date
function postCountToMaxDate(postCount: number) {
  assert(Number.isInteger(postCount));
  // postCount to seconds of waiting
  // Now that we have akismet, 10 seconds is long enough.
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

// Date -> String
//
// 'in 1 minute and 13 seconds'
function waitLength(tilDate: Date) {
  // diff is in seconds
  const diff = Math.max(0, Math.ceil((tilDate.getTime() - Date.now()) / 1000));
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  let output = "";
  if (mins > 1) output += `${mins} minutes and `;
  else if (mins === 1) output += `${mins} minute and `;
  if (secs === 1) output += `${secs} second`;
  else output += `${secs} seconds`;
  return output;
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
          ${waitLength(
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
