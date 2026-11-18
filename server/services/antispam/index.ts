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
import { AlreadyNuked } from "../../db/refusals";
import type { ScreeningCharge } from "../../db/screen_budget";
import type { SpamVerdict } from "./claude";

// The member whose write is screened. The Discord notes link their profile.
export type SpamActor = { id: number; uname: string; slug: string };

// A spam verdict and what process did about it. NUKE and REVIEW both mean the
// text is suspected spam.
export type SpamFinding = { action: "NUKE" | "REVIEW"; verdict: SpamVerdict };

// Screens the text a write stored, and acts on the verdict. Returns null when
// the text passes or the classifier fails open, and the finding for NUKE and
// REVIEW, so the caller can skip the intro-topic broadcast for a suspected
// spammer, and on a NUKE hide what the write changed outside the actor's own
// rows.
//
// `charge` is what the write that stored the text returned
// (server/db/screen_budget.ts#spendScreening). It decides whether the text is
// screened: null means the actor is trusted, and nothing is sent.
async function process(
  actor: SpamActor,
  charge: ScreeningCharge | null,
  postId: number,
): Promise<SpamFinding | null> {
  assert(Number.isInteger(actor.id));
  assert(Number.isInteger(postId));

  if (!charge) {
    return null;
  }
  assert(
    charge.standing.id === actor.id,
    "A screening charge must belong to the actor",
  );

  const result = await claude.analyze(charge);
  const action = decideAction(result);

  console.log("antispam process:", { action, result });

  if (action === "ALLOW") {
    if (charge.standing.posts_count === 0) {
      const antispam = result.ok
        ? ({ ran: true } as const)
        : ({ ran: false, error: result.error } as const);
      broadcastFirstPost(actor, postId, antispam, charge.body).catch((err) =>
        console.error("broadcastFirstPost failed", err),
      );
    }
    return null;
  }

  // NUKE and REVIEW both imply a successful, spam verdict.
  assert(result.ok);
  const { verdict } = result;

  if (action === "NUKE") {
    // It's high-confidence spam, so nuke user and post in Discord.
    await db
      .nukeUser({
        spambot: actor.id,
        nuker: config.STAFF_REPRESENTATIVE_ID || 1,
      })
      .catch(ignoreAlreadyNuked);

    broadcastAutoNuke(actor, postId, verdict).catch((err) => {
      console.error("broadcastAutoNuke failed", err);
    });
  } else {
    // REVIEW: mid-confidence spam. Alert Discord for a human to review, but do
    // not nuke.
    broadcastSpamReview(actor, postId, verdict).catch((err) => {
      console.error("broadcastSpamReview failed", err);
    });
  }

  return { action, verdict };
}

// Two writes screened at once can both come back NUKE, and the second finds
// the account nuked already. That NUKE still stands: the text it judged may
// sit in a row the actor does not own, which nukeUser does not hide, and the
// moderators still hear about it.
function ignoreAlreadyNuked(err: unknown): void {
  if (err instanceof AlreadyNuked) return;
  throw err;
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

function logFinding(finding: SpamFinding | null): SpamFinding | null {
  if (finding) {
    console.log("antispam process detected a spammer:", finding);
  }
  return finding;
}

function logError(err: unknown): null {
  console.error("antispam process error", err);
  return null;
}

export default {
  checkClassifier,
  startClassifierProbe,
  // Never rejects: an error is logged, and the text passes.
  process: async (
    actor: SpamActor,
    charge: ScreeningCharge | null,
    postId: number,
  ): Promise<SpamFinding | null> => {
    return process(actor, charge, postId).then(logFinding).catch(logError);
  },
};
