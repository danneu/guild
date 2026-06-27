// 3rd
import assert from "assert";
// 1st
import claude from "./claude";
import { decideAction } from "./policy";
import * as config from "../../config";
import { broadcastAutoNuke, broadcastSpamReview } from "../discord";
import * as db from "../../db";
import { Context } from "koa";

// Returns falsey if they are not a spammer (or if we fail open). Returns the
// verdict (truthy) for both NUKE and REVIEW so the caller suppresses the
// intro-topic broadcast for a suspected spammer.
//
// `title` is only passed for topic creation; replies and edits omit it.
async function process(
  ctx: Context,
  markup: string,
  postId: number,
  title?: string,
) {
  assert(ctx.currUser);
  assert(typeof markup === "string");
  assert(Number.isInteger(postId));

  // Bail if user is approved or if they have more than 5 posts
  if (ctx.currUser.approved_at || ctx.currUser.posts_count > 5) {
    return;
  }

  const result = await claude.analyze(ctx, markup, title);
  const action = decideAction(result);

  console.log("antispam process:", { action, result });

  if (action === "ALLOW") {
    return;
  }

  // NUKE and REVIEW both imply a successful, spam verdict.
  assert(result.ok);
  const { verdict } = result;

  if (action === "NUKE") {
    // It's high-confidence spam, so nuke user and post in Discord.
    await db.nukeUser({
      spambot: ctx.currUser.id,
      nuker: config.STAFF_REPRESENTATIVE_ID || 1,
    });

    // Send email (Turned off for now since it's redundant)
    // emailer.sendAutoNukeEmail(ctx.currUser.slug, markup)

    broadcastAutoNuke(ctx.currUser, postId, verdict).catch((err) => {
      console.error("broadcastAutoNuke failed", err);
    });
  } else {
    // REVIEW: mid-confidence spam. Alert Discord for a human to review, but do
    // not nuke.
    broadcastSpamReview(ctx.currUser, postId, verdict).catch((err) => {
      console.error("broadcastSpamReview failed", err);
    });
  }

  return verdict;
}

export default {
  process: async (
    ctx: Context,
    markup: string,
    postId: number,
    title?: string,
  ) => {
    return process(ctx, markup, postId, title)
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
