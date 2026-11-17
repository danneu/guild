// 3rd
import assert from "assert";
// 1st
import claude from "./claude";
import { decideAction } from "./policy";
import * as config from "../../config";
import {
  broadcastAutoNuke,
  broadcastFirstPost,
  broadcastSpamReview,
} from "../discord";
import * as db from "../../db";
import type { ScreeningCharge } from "../../db/screen_budget";
import { Context } from "koa";

// Returns falsey if they are not a spammer (or if we fail open). Returns the
// verdict (truthy) for both NUKE and REVIEW so the caller suppresses the
// intro-topic broadcast for a suspected spammer.
//
// `charge` is what the write that stored the text returned
// (server/db/screen_budget.ts#spendScreening). It decides whether the text is
// screened: null means the actor is trusted, and nothing is sent.
async function process(
  ctx: Context,
  charge: ScreeningCharge | null,
  postId: number,
) {
  assert(ctx.currUser);
  assert(Number.isInteger(postId));

  if (!charge) {
    return;
  }
  assert(
    charge.standing.id === ctx.currUser.id,
    "A screening charge must belong to the request's user",
  );

  const result = await claude.analyze(charge);
  const action = decideAction(result);

  console.log("antispam process:", { action, result });

  if (action === "ALLOW") {
    if (charge.standing.posts_count === 0) {
      const antispam = result.ok
        ? ({ ran: true } as const)
        : ({ ran: false, error: result.error } as const);
      broadcastFirstPost(ctx.currUser, postId, antispam, charge.body).catch(
        (err) => console.error("broadcastFirstPost failed", err),
      );
    }
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
    charge: ScreeningCharge | null,
    postId: number,
  ) => {
    return process(ctx, charge, postId)
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
