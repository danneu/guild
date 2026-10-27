import { beforeEach, describe, expect, it, vi } from "vitest";

import { postRow, topicRow } from "../cancan.fixtures";
import { pool } from "./util";
import { findRecentTopicsForUserId } from "./index";

// bbcode.js loads cache3 with a CommonJS require, which vitest cannot resolve.
vi.mock("../bbcode", () => ({ default: {} }));

// The repo has no real-database tests, so these read the SQL the finder sends
// and feed it rows by hand.
vi.mock("./util", () => ({
  pool: { query: vi.fn() },
}));

const query = vi.mocked(pool.query) as any;

beforeEach(() => {
  query.mockReset();
});

describe("findRecentTopicsForUserId", () => {
  // Intent: a topic's preview is its opening post, scoped like any listing.
  // Why it exists: the preview was the topic's latest post by anyone, with
  // no read check, so a guest read a reply that mods had hidden
  // (hunt 261026-0911-030).
  // Scenario: a guest opens a member's recent-topics tab, and the opening
  // post of one topic is hidden, so the scoped preview query finds nothing.
  it("gives a guest no preview when the opening post is hidden", async () => {
    const topic = topicRow({ mods: [] });
    query
      .mockResolvedValueOnce({ rows: [topic] })
      .mockResolvedValueOnce({ rows: [] });

    const topics = await findRecentTopicsForUserId(
      undefined,
      topic.user_id,
      undefined,
    );

    expect(topics.map((t) => t.first_post)).toEqual([null]);
    const previewSql: string = query.mock.calls[1][0];
    expect(previewSql).toContain(
      `"p"."id" in (select min("id") from "posts" where "topic_id" in (${topic.id}) group by "topic_id")`,
    );
    expect(previewSql).toContain(`"p"."is_hidden" = false`);
  });

  it("attaches each topic's opening post", async () => {
    const topic = topicRow({ mods: [] });
    const openingPost = postRow(topic, { topic_id: topic.id });
    query
      .mockResolvedValueOnce({ rows: [topic] })
      .mockResolvedValueOnce({ rows: [openingPost] });

    const topics = await findRecentTopicsForUserId(
      undefined,
      topic.user_id,
      undefined,
    );

    expect(topics.map((t) => t.first_post)).toEqual([openingPost]);
  });
});
