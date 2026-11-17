// 3rd party
// import createDebug from 'debug'
// const debug = createDebug('app:middleware')
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
