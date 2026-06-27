// 1st
import type { AnalyzeResult } from "./claude";

export const NUKE_CONFIDENCE = 0.9;
export const REVIEW_CONFIDENCE = 0.7;

export type SpamAction = "NUKE" | "REVIEW" | "ALLOW";

// Maps an analysis result to an action. Fails open: an API error/timeout, a
// not-spam verdict, or spam below the review threshold all map to ALLOW.
//
//   is_spam && confidence >= 0.9        -> NUKE
//   is_spam && 0.7 <= confidence < 0.9  -> REVIEW
//   otherwise                           -> ALLOW
export function decideAction(r: AnalyzeResult): SpamAction {
  if (!r.ok) return "ALLOW";

  const { isSpam, confidence } = r.verdict;
  if (!isSpam) return "ALLOW";
  if (confidence >= NUKE_CONFIDENCE) return "NUKE";
  if (confidence >= REVIEW_CONFIDENCE) return "REVIEW";
  return "ALLOW";
}
