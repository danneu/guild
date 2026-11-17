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
import type { ScreeningCharge } from "../../db/screen_budget";

const analyze = vi.mocked(claude.analyze);
const nukeUser = vi.mocked(db.nukeUser);
const autoNuke = vi.mocked(broadcastAutoNuke);
const firstPost = vi.mocked(broadcastFirstPost);
const spamReview = vi.mocked(broadcastSpamReview);

function makeCtx(): any {
  return { currUser: { id: 42, uname: "spammer", slug: "spammer" } };
}

// Only server/db/screen_budget.ts makes a real charge; the cast stands in.
function charge(
  body: string,
  standing: { posts_count?: number; id?: number } = {},
): ScreeningCharge {
  return {
    standing: {
      id: 42,
      uname: "spammer",
      posts_count: 0,
      trusted: false,
      ...standing,
    },
    cost: 9,
    body,
    take: () => JSON.stringify({ username: "spammer", title: null, body }),
  } as unknown as ScreeningCharge;
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

    const result = await antispam.process(makeCtx(), charge("buy coins"), 100);

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

    const result = await antispam.process(makeCtx(), charge("maybe spam"), 101);

    expect(nukeUser).not.toHaveBeenCalled();
    expect(spamReview).toHaveBeenCalledTimes(1);
    expect(autoNuke).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    // Truthy so server/index.ts suppresses the intro broadcast.
    expect(result).toBeTruthy();
  });

  it("ALLOW (not spam): broadcasts the clean first post, returns falsey", async () => {
    analyze.mockResolvedValue(verdict({ isSpam: false, confidence: 0.99 }));

    const result = await antispam.process(
      makeCtx(),
      charge("hi everyone"),
      102,
    );

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

    const result = await antispam.process(makeCtx(), charge("anything"), 103);

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
      makeCtx(),
      charge("hi again", { posts_count: 3 }),
      106,
    );

    expect(nukeUser).not.toHaveBeenCalled();
    expect(autoNuke).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });

  // A trusted actor's write returns no charge (server/db/send_budget.ts's
  // lockStanding decides trust), and no charge means no call.
  it("no charge: sends nothing to the classifier", async () => {
    const result = await antispam.process(makeCtx(), null, 104);

    expect(analyze).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });

  it("refuses a charge another user paid", async () => {
    const result = await antispam.process(
      makeCtx(),
      charge("anything", { id: 43 }),
      105,
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });
});
