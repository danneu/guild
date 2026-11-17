// 3rd
import assert from "assert";
// 1st
import claude from "./claude";
import { decideAction } from "./policy";
import * as config from "../../config";
import {
  broadcastAutoNuke,
  broadcastClassifierFailing,
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

// How often each machine checks that the classifier answers. A revoked key or
// a retired model does not wait for a deploy, so the check repeats.
const PROBE_INTERVAL_MS = 1000 * 60 * 60 * 24;

// Checks that the classifier answers, by classifying a fixed clean sample. It
// reads only whether a verdict came back, never the verdict, and takes no
// moderation action. With no verdict every screened post fails open to ALLOW,
// so staff get a Discord note.
async function checkClassifier(): Promise<void> {
  const result = await claude.probe();
  if (result.ok) return;
  console.error(
    "[antispam] classifier probe got no verdict; screening fails open:",
    result.error,
  );
  await broadcastClassifierFailing(result.error);
}

let probeStarted = false;

// Idempotent. In production with a key configured, checks the classifier now
// and then every PROBE_INTERVAL_MS, in the background. The interval is unref'd
// so scripts and tests never hang on it. Only server/index.ts calls this
// (after app.listen).
function startClassifierProbe(): void {
  if (probeStarted) return;
  probeStarted = true;
  if (config.NODE_ENV !== "production" || !config.IS_ANTISPAM_CONFIGURED) {
    return;
  }
  function check() {
    checkClassifier().catch((err) =>
      console.error("antispam probe error", err),
    );
  }
  check();
  setInterval(check, PROBE_INTERVAL_MS).unref();
}

function logVerdict<T>(result: T): T {
  if (result) {
    console.log("antispam process detected a spammer:", result);
  }
  return result;
}

function logError(err: unknown): void {
  console.error("antispam process error", err);
}

export default {
  checkClassifier,
  startClassifierProbe,
  // For a caller that waits for the verdict. Never rejects: an error is
  // logged and the text passes.
  process: async (
    ctx: Context,
    charge: ScreeningCharge | null,
    postId: number,
  ) => {
    return process(ctx, charge, postId).then(logVerdict).catch(logError);
  },
  // The one entry point for screening after the response is sent. It returns
  // nothing, so a route has no promise to drop.
  processInBackground(
    ctx: Context,
    charge: ScreeningCharge | null,
    postId: number,
  ): void {
    process(ctx, charge, postId).then(logVerdict).catch(logError);
  },
};
