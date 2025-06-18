// 3rd
import assert from "assert";
// 1st
import akismet from "./akismet";
import * as config from "../../config";
import { broadcastAutoNuke } from "../discord";
import * as db from "../../db";
import { Context } from "koa";

// Returns { test: 'SUBSTRING' | 'AKISMET', isSpam: Boolean, info: ... }
async function analyze(ctx: Context, text: string) {
  // SUBSTRING check is too aggressive, too many false positives.

  // ;{
  //   const info = await substring.analyze(text)
  //
  //   console.log('antispam analyze (substring):', info)
  //
  //   if (info.isSpam) {
  //     return { isSpam: true, test: 'SUBSTRING', info }
  //   }
  // }

  {
    const info = await akismet.analyze(ctx, text);

    console.log("antispam analyze (akismet):", info);

    if (info === "SPAM") {
      return { isSpam: true, test: "AKISMET", info };
    }
  }

  return { isSpam: false };
}

// Returns falsey if they are not a spammer
async function process(ctx: Context, markup: string, postId: number) {
  assert(ctx.currUser);
  assert(typeof markup === "string");
  assert(Number.isInteger(postId));

  // Bail if user is approved or if they have more than 5 posts
  if (ctx.currUser.approved_at || ctx.currUser.posts_count > 5) {
    return;
  }

  const result = await analyze(ctx, markup);

  console.log("antispam process:", result);

  // Not spam? Then nothing to do.
  if (!result.isSpam) {
    return;
  }

  // It's spam, so nuke user, send email, and post in Discord
  await db.nukeUser({
    spambot: ctx.currUser.id,
    nuker: config.STAFF_REPRESENTATIVE_ID || 1,
  });

  // Send email (Turned off for now since it's redundant)
  // emailer.sendAutoNukeEmail(ctx.currUser.slug, markup)

  // Broadcast to Discord
  broadcastAutoNuke(ctx.currUser, postId, result).catch((err) => {
    console.error("broadcastAutoNuke failed", err);
  });

  return result;
}

export default {
  analyze,
  process: async (ctx: Context, markup: string, postId: number) => {
    return process(ctx, markup, postId)
      .then((result) => {
        if (result) {
          console.log("antispam process detected a spammer:", result);
        }
        return result;
      })
      .catch((err) => {
        console.error("antispam process error", err);
      });
  },
};
