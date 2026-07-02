import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the collaborators so process() wiring is exercised without HTTP, the DB,
// or Discord. These directly guard the silent failure modes: forgetting to
// nuke, nuking on REVIEW, and returning falsey on REVIEW (which would let
// server/index.ts broadcast a suspected-spam intro to #general).
vi.mock("./claude", () => ({
  default: { analyze: vi.fn() },
}));
vi.mock("../../db", () => ({
  nukeUser: vi.fn(() => Promise.resolve()),
}));
vi.mock("../discord", () => ({
  broadcastAutoNuke: vi.fn(() => Promise.resolve()),
  broadcastFirstPost: vi.fn(() => Promise.resolve()),
  broadcastSpamReview: vi.fn(() => Promise.resolve()),
}));

import antispam from "./index";
import claude from "./claude";
import * as db from "../../db";
import * as config from "../../config";
import {
  broadcastAutoNuke,
  broadcastFirstPost,
  broadcastSpamReview,
} from "../discord";
import type { AnalyzeResult, SpamVerdict } from "./claude";

const analyze = vi.mocked(claude.analyze);
const nukeUser = vi.mocked(db.nukeUser);
const autoNuke = vi.mocked(broadcastAutoNuke);
const firstPost = vi.mocked(broadcastFirstPost);
const spamReview = vi.mocked(broadcastSpamReview);

function makeCtx(currUser: Record<string, unknown> = {}): any {
  return {
    currUser: {
      id: 42,
      uname: "spammer",
      approved_at: null,
      posts_count: 0,
      ...currUser,
    },
  };
}

function verdict(over: Partial<SpamVerdict> = {}): AnalyzeResult {
  return {
    ok: true,
    verdict: {
      isSpam: true,
      confidence: 0.95,
      category: "gambling_betting",
      reasoning: "test",
      injectionAttempt: false,
      ...over,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("antispam.process wiring", () => {
  it("NUKE: nukes the user, broadcasts the nuke, returns truthy", async () => {
    analyze.mockResolvedValue(verdict({ confidence: 0.95 }));

    const result = await antispam.process(makeCtx(), "buy coins", 100, "title");

    expect(nukeUser).toHaveBeenCalledTimes(1);
    expect(nukeUser).toHaveBeenCalledWith({
      spambot: 42,
      nuker: config.STAFF_REPRESENTATIVE_ID || 1,
    });
    expect(autoNuke).toHaveBeenCalledTimes(1);
    expect(firstPost).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  it("REVIEW: does not nuke, broadcasts a review note, returns truthy", async () => {
    analyze.mockResolvedValue(verdict({ confidence: 0.8 }));

    const result = await antispam.process(
      makeCtx(),
      "maybe spam",
      101,
      "title",
    );

    expect(nukeUser).not.toHaveBeenCalled();
    expect(spamReview).toHaveBeenCalledTimes(1);
    expect(autoNuke).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    // Truthy so server/index.ts suppresses the intro broadcast.
    expect(result).toBeTruthy();
  });

  it("ALLOW (not spam): broadcasts the clean first post, returns falsey", async () => {
    analyze.mockResolvedValue(verdict({ isSpam: false, confidence: 0.99 }));

    const result = await antispam.process(makeCtx(), "hi everyone", 102, "hi");

    expect(nukeUser).not.toHaveBeenCalled();
    expect(autoNuke).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(firstPost).toHaveBeenCalledTimes(1);
    expect(firstPost).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      102,
      { ran: true },
      "hi everyone",
    );
    expect(result).toBeFalsy();
  });

  it("API timeout: fails open and broadcasts first post review metadata", async () => {
    analyze.mockResolvedValue({ ok: false, error: "API_TIMEOUT" });

    const result = await antispam.process(makeCtx(), "anything", 103);

    expect(nukeUser).not.toHaveBeenCalled();
    expect(autoNuke).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(firstPost).toHaveBeenCalledTimes(1);
    expect(firstPost).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      103,
      { ran: false, error: "API_TIMEOUT" },
      "anything",
    );
    expect(result).toBeFalsy();
  });

  it("ALLOW (not first post): does not broadcast first post", async () => {
    analyze.mockResolvedValue(verdict({ isSpam: false, confidence: 0.99 }));

    const result = await antispam.process(
      makeCtx({ posts_count: 3 }),
      "hi again",
      106,
      "hi",
    );

    expect(nukeUser).not.toHaveBeenCalled();
    expect(autoNuke).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });

  it("gate: approved user is not sent to the classifier", async () => {
    const result = await antispam.process(
      makeCtx({ approved_at: new Date() }),
      "anything",
      104,
      "title",
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });

  it("gate: user with > 5 posts is not sent to the classifier", async () => {
    const result = await antispam.process(
      makeCtx({ posts_count: 6 }),
      "anything",
      105,
      "title",
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });
});
