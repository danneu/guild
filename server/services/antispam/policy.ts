// 1st
import type { AnalyzeResult } from "./claude";

export const NUKE_CONFIDENCE = 0.9;
export const REVIEW_CONFIDENCE = 0.7;

export type SpamAction = "NUKE" | "REVIEW" | "ALLOW";

// Maps an analysis result on an actor's text to an action. Fails open: an
// API error/timeout, a not-spam verdict, or spam below the review threshold
// all map to ALLOW.
//
//   isSpam && confidence >= 0.9        -> NUKE, or REVIEW for a demoted actor
//   isSpam && 0.7 <= confidence < 0.9  -> REVIEW
//   otherwise                           -> ALLOW
//
// A demoted actor (server/trust.ts#Trust) had enough aged posts to be trusted
// until staff hid some, so they are screened again. One false positive must
// not nuke a long-time member, so a mod decides instead. A spammer whose aged
// posts were hidden is reviewed the same way, by the mods who hid them.
export function decideAction(
  r: AnalyzeResult,
  actor: { demoted: boolean },
): SpamAction {
  if (!r.ok) return "ALLOW";

  const { isSpam, confidence } = r.verdict;
  if (!isSpam) return "ALLOW";
  if (confidence >= NUKE_CONFIDENCE) return actor.demoted ? "REVIEW" : "NUKE";
  if (confidence >= REVIEW_CONFIDENCE) return "REVIEW";
  return "ALLOW";
}
