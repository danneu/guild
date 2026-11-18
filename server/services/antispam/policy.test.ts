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

const newcomer = { demoted: false };
const demoted = { demoted: true };

describe("decideAction", () => {
  it("nukes high-confidence spam (>= 0.9)", () => {
    expect(decideAction(spam(NUKE_CONFIDENCE), newcomer)).toBe("NUKE");
    expect(decideAction(spam(0.95), newcomer)).toBe("NUKE");
    expect(decideAction(spam(1), newcomer)).toBe("NUKE");
  });

  // Intent: a member who is untrusted only because staff hid some of their
  // aged posts is never nuked automatically.
  // Why it exists: hiding a veteran's posts makes them untrusted, so their
  // next post goes to the classifier, where one false positive would nuke a
  // long-time member (hunt 261117-0852-003).
  it("only reviews high-confidence spam by a demoted actor", () => {
    expect(decideAction(spam(NUKE_CONFIDENCE), demoted)).toBe("REVIEW");
    expect(decideAction(spam(1), demoted)).toBe("REVIEW");
  });

  it("reviews mid-confidence spam (0.7 - 0.9)", () => {
    expect(decideAction(spam(REVIEW_CONFIDENCE), newcomer)).toBe("REVIEW");
    expect(decideAction(spam(0.8), newcomer)).toBe("REVIEW");
    expect(decideAction(spam(0.89), demoted)).toBe("REVIEW");
  });

  it("allows low-confidence spam (< 0.7)", () => {
    expect(decideAction(spam(0.69), newcomer)).toBe("ALLOW");
    expect(decideAction(spam(0.1), demoted)).toBe("ALLOW");
  });

  it("allows a not-spam verdict at any confidence", () => {
    expect(decideAction(spam(0.99, false), newcomer)).toBe("ALLOW");
    expect(decideAction(spam(0.5, false), demoted)).toBe("ALLOW");
  });

  it("fails open on API error or timeout", () => {
    expect(decideAction({ ok: false, error: "API_ERROR" }, newcomer)).toBe(
      "ALLOW",
    );
    expect(decideAction({ ok: false, error: "API_TIMEOUT" }, demoted)).toBe(
      "ALLOW",
    );
  });
});
