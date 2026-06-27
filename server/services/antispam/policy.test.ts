import { describe, it, expect } from "vitest";
import { decideAction, NUKE_CONFIDENCE, REVIEW_CONFIDENCE } from "./policy";
import type { AnalyzeResult } from "./claude";

function spam(confidence: number, isSpam = true): AnalyzeResult {
  return {
    ok: true,
    verdict: {
      isSpam,
      confidence,
      category: isSpam ? "gambling_betting" : "legitimate",
      reasoning: "test",
      injectionAttempt: false,
    },
  };
}

describe("decideAction", () => {
  it("nukes high-confidence spam (>= 0.9)", () => {
    expect(decideAction(spam(NUKE_CONFIDENCE))).toBe("NUKE");
    expect(decideAction(spam(0.95))).toBe("NUKE");
    expect(decideAction(spam(1))).toBe("NUKE");
  });

  it("reviews mid-confidence spam (0.7 - 0.9)", () => {
    expect(decideAction(spam(REVIEW_CONFIDENCE))).toBe("REVIEW");
    expect(decideAction(spam(0.8))).toBe("REVIEW");
    expect(decideAction(spam(0.89))).toBe("REVIEW");
  });

  it("allows low-confidence spam (< 0.7)", () => {
    expect(decideAction(spam(0.69))).toBe("ALLOW");
    expect(decideAction(spam(0.1))).toBe("ALLOW");
  });

  it("allows a not-spam verdict at any confidence", () => {
    expect(decideAction(spam(0.99, false))).toBe("ALLOW");
    expect(decideAction(spam(0.5, false))).toBe("ALLOW");
  });

  it("fails open on API error or timeout", () => {
    expect(decideAction({ ok: false, error: "API_ERROR" })).toBe("ALLOW");
    expect(decideAction({ ok: false, error: "API_TIMEOUT" })).toBe("ALLOW");
  });
});
