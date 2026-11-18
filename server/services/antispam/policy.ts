// 1st
import type { AnalyzeResult } from "./claude";

export const NUKE_CONFIDENCE = 0.9;
export const REVIEW_CONFIDENCE = 0.7;

export type SpamAction = "NUKE" | "REVIEW" | "ALLOW";

// What a screened write stored: a post's text or a topic's title, or text
// outside the forums.
export type SubjectKind = "post" | "campaign" | "bio" | "sig";

// Maps an analysis result on an actor's text to an action. Fails open: an
// API error/timeout, a not-spam verdict, or spam below the review threshold
// all map to ALLOW.
//
//   isSpam && confidence >= 0.9        -> NUKE, or REVIEW for a demoted actor
//                                         or for text outside a post
//   isSpam && 0.7 <= confidence < 0.9  -> REVIEW
//   otherwise                           -> ALLOW
//
// A demoted actor (server/trust.ts#Trust) had enough aged posts to be trusted
// until staff hid some, so they are screened again. One false positive must
// not nuke a long-time member, so a mod decides instead. A spammer whose aged
// posts were hidden is reviewed the same way, by the mods who hid them.
//
// A verdict on text outside a post only flags it for review: a mod decides
// whether a campaign, bio or sig is spam (hunt 261117-0852-055).
export function decideAction(
  r: AnalyzeResult,
  write: { demoted: boolean; subject: SubjectKind },
): SpamAction {
  if (!r.ok) return "ALLOW";

  const { isSpam, confidence } = r.verdict;
  if (!isSpam) return "ALLOW";
  if (confidence >= NUKE_CONFIDENCE) {
    return write.demoted || write.subject !== "post" ? "REVIEW" : "NUKE";
  }
  if (confidence >= REVIEW_CONFIDENCE) return "REVIEW";
  return "ALLOW";
}
