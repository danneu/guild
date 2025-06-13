// 3rd
import assert from "assert";
// 1st
import * as belt from "../../belt";
import * as akismet from "../../akismet";
import { Context } from "koa";

// Returns SPAM | NOT_SPAM | API_TIMEOUT | API_ERROR
// Only SPAM should result in a nuke
async function analyze(ctx: Context, markup: string) {
  assert(ctx.currUser);
  assert(typeof markup === "string");

  return await Promise.race([
    belt.timeout(10000).then(() => "API_TIMEOUT"),
    akismet
      .checkComment({
        commentType: "reply",
        commentAuthor: ctx.currUser.uname,
        commentAuthorEmail: ctx.currUser.email,
        commentContent: markup,
        userIp: ctx.ip,
        userAgent: ctx.headers["user-agent"] ?? "",
      })
      .then((isSpam) => (isSpam ? "SPAM" : "NOT_SPAM")),
  ]).catch((err) => {
    // On error, just let them post
    console.error("akismet error", err);
    return "API_ERROR";
  });
}

export default {
  analyze,
};
