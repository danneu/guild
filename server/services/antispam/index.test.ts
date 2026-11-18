import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the collaborators so process() wiring is exercised without HTTP, the DB,
// or Discord. These directly guard the silent failure modes: forgetting to
// nuke, nuking on REVIEW, and returning falsey on REVIEW (which would let a
// suspected spammer's intro topic be broadcast to #general).
vi.mock("./claude", () => ({
  default: { analyze: vi.fn(), probe: vi.fn() },
}));
vi.mock("../../db", () => ({
  nukeUser: vi.fn(() => Promise.resolve()),
}));
vi.mock("../discord", () => ({
  broadcastAutoNuke: vi.fn(() => Promise.resolve()),
  broadcastClassifierFailing: vi.fn(() => Promise.resolve()),
  broadcastSpamReview: vi.fn(() => Promise.resolve()),
  relayOnce: vi.fn(() => Promise.resolve()),
}));

import antispam from "./index";
import claude from "./claude";
import * as db from "../../db";
import * as config from "../../config";
import {
  broadcastAutoNuke,
  broadcastClassifierFailing,
  broadcastSpamReview,
  relayOnce,
} from "../discord";
import type { AnalyzeResult, SpamVerdict } from "./claude";
import type { ScreeningCharge } from "../../db/screen_budget";

const analyze = vi.mocked(claude.analyze);
const probe = vi.mocked(claude.probe);
const nukeUser = vi.mocked(db.nukeUser);
const autoNuke = vi.mocked(broadcastAutoNuke);
const classifierFailing = vi.mocked(broadcastClassifierFailing);
const firstPost = vi.mocked(relayOnce);
const spamReview = vi.mocked(broadcastSpamReview);

function actor() {
  return { id: 42, uname: "spammer", slug: "spammer" };
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
      demoted: false,
      ...standing,
    },
    cost: 9,
    body,
    take: () => JSON.stringify({ username: "spammer", title: null, body }),
  } as unknown as ScreeningCharge;
}

function post(postId: number) {
  return { kind: "post", postId } as const;
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

    const result = await antispam.process(
      actor(),
      charge("buy coins"),
      post(100),
    );

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
      actor(),
      charge("maybe spam"),
      post(101),
    );

    expect(nukeUser).not.toHaveBeenCalled();
    expect(spamReview).toHaveBeenCalledTimes(1);
    expect(spamReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      "/posts/101/raw",
      expect.objectContaining({ confidence: 0.8 }),
    );
    expect(autoNuke).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    // Truthy so the intro broadcast is skipped.
    expect(result).toBeTruthy();
  });

  // Intent: a zero-post member's clean campaign, bio or sig is not announced
  // as a first post.
  // Why it exists: the first post note links /posts/<id>, and text outside
  // the forums has no post (hunt 261117-0852-055).
  it("ALLOW outside a post: relays no first post", async () => {
    analyze.mockResolvedValue(verdict({ isSpam: false, confidence: 0.99 }));

    const result = await antispam.process(actor(), charge("my campaign"), {
      kind: "campaign",
      url: "/campaigns/7",
    });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });

  it("ALLOW (not spam): broadcasts the clean first post, returns falsey", async () => {
    analyze.mockResolvedValue(verdict({ isSpam: false, confidence: 0.99 }));

    const result = await antispam.process(
      actor(),
      charge("hi everyone"),
      post(102),
    );

    expect(nukeUser).not.toHaveBeenCalled();
    expect(autoNuke).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(firstPost).toHaveBeenCalledTimes(1);
    expect(firstPost).toHaveBeenCalledWith(
      "first_post",
      expect.objectContaining({ id: 42 }),
      { postId: 102, antispam: { ran: true }, markup: "hi everyone" },
    );
    expect(result).toBeFalsy();
  });

  it("API timeout: fails open and broadcasts first post review metadata", async () => {
    analyze.mockResolvedValue({ ok: false, error: "API_TIMEOUT" });

    const result = await antispam.process(
      actor(),
      charge("anything"),
      post(103),
    );

    expect(nukeUser).not.toHaveBeenCalled();
    expect(autoNuke).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(firstPost).toHaveBeenCalledTimes(1);
    expect(firstPost).toHaveBeenCalledWith(
      "first_post",
      expect.objectContaining({ id: 42 }),
      {
        postId: 103,
        antispam: { ran: false, error: "API_TIMEOUT" },
        markup: "anything",
      },
    );
    expect(result).toBeFalsy();
  });

  it("ALLOW (not first post): does not broadcast first post", async () => {
    analyze.mockResolvedValue(verdict({ isSpam: false, confidence: 0.99 }));

    const result = await antispam.process(
      actor(),
      charge("hi again", { posts_count: 3 }),
      post(106),
    );

    expect(nukeUser).not.toHaveBeenCalled();
    expect(autoNuke).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });

  // A trusted actor's write returns no charge (server/trust.ts decides trust,
  // and server/db/send_budget.ts#lockStanding reads it), and no charge means
  // no call.
  it("no charge: sends nothing to the classifier", async () => {
    const result = await antispam.process(actor(), null, post(104));

    expect(analyze).not.toHaveBeenCalled();
    expect(firstPost).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });

  it("refuses a charge another user paid", async () => {
    const result = await antispam.process(
      actor(),
      charge("anything", { id: 43 }),
      post(105),
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(result).toBeFalsy();
  });
});

describe("antispam.checkClassifier", () => {
  // Intent: staff hear when the classifier stops answering, and only then.
  // Why it exists: a revoked key, a retired model or an API change turns
  // every call into an error, which allows every post, and only the log said
  // so (hunt 261117-0852-016).
  // Scenario: the probe gets a verdict, then gets none.
  it("sends no note when the probe gets a verdict", async () => {
    probe.mockResolvedValue(verdict({ isSpam: true, confidence: 0.99 }));

    await antispam.checkClassifier();

    expect(classifierFailing).not.toHaveBeenCalled();
    expect(nukeUser).not.toHaveBeenCalled();
    expect(spamReview).not.toHaveBeenCalled();
  });

  it("sends one note naming the error when the probe gets no verdict", async () => {
    probe.mockResolvedValue({ ok: false, error: "API_ERROR" });

    await antispam.checkClassifier();

    expect(classifierFailing).toHaveBeenCalledTimes(1);
    expect(classifierFailing).toHaveBeenCalledWith("API_ERROR");
    expect(analyze).not.toHaveBeenCalled();
  });
});
