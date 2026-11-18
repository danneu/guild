// Intent: whether a member is still new is read from their live posts, on real
// rows in a real Postgres (server/testing/db.ts). Each filter of the rule is
// tested on both sides, through one member's read and through a list query
// that embeds the rule.
// Why it exists: a member was trusted once users.posts_count passed five. Six
// one-line posts, made in about a minute, switched the spam check off for
// good and raised every budget, and hiding the posts changed nothing (hunt
// 261117-0852-003). The pg stubs ignore a query's WHERE clause, so only real
// rows can show the rule.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "./config";
import { pool } from "./db/util";
import * as forumText from "./forum_text";
import claude, { type AnalyzeResult } from "./services/antispam/claude";
import { broadcastAutoNuke, broadcastSpamReview } from "./services/discord";
import { closeTestDatabase, emptyTables } from "./testing/db";
import { readTrust, trustedSql, type Trust } from "./trust";

vi.mock("./db/util", async (importOriginal) =>
  (await import("./testing/db")).onTestDatabase(
    await importOriginal<typeof import("./db/util")>(),
  ),
);

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest, and importing cache3 starts its refresh loop.
// Nothing here reads rendered html.
vi.mock("./bbcode", () => ({ default: (markup: string) => markup }));
vi.mock("./cache3", () => ({ default: { requestUpdate: vi.fn() } }));
vi.mock("./services/antispam/claude", () => ({
  default: { analyze: vi.fn(), probe: vi.fn() },
}));
vi.mock("./services/discord", () => ({
  broadcastAutoNuke: vi.fn(async () => {}),
  broadcastClassifierFailing: vi.fn(async () => {}),
  broadcastFirstPost: vi.fn(async () => {}),
  broadcastSpamReview: vi.fn(async () => {}),
}));

const analyze = vi.mocked(claude.analyze);

beforeEach(async () => {
  vi.clearAllMocks();
  await emptyTables();
});
afterAll(closeTestDatabase);

const MINUTE = 60;
// Post ages just either side of the floor
const AGED = config.TRUST_MIN_POST_AGE_SECONDS + MINUTE;
const YOUNG = config.TRUST_MIN_POST_AGE_SECONDS - MINUTE;

function verdict(isSpam: boolean, confidence: number): AnalyzeResult {
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

async function createMember(
  uname: string,
  opts: { approved?: boolean } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO users (uname, digest, email, slug, approved_at)
    VALUES ($1, '', $1 || '@example.com', $1,
      CASE WHEN $2 THEN now() END)
    RETURNING id
  `,
    [uname, opts.approved ?? false],
  );
  return rows[0]!.id;
}

async function createForum(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(`
    WITH category AS (
      INSERT INTO categories (title, pos) VALUES ('Lobby', 0) RETURNING id
    )
    INSERT INTO forums (category_id, title, pos)
    SELECT id, 'General', 0 FROM category
    RETURNING id
  `);
  return rows[0]!.id;
}

type SeedPost = {
  ageSeconds: number;
  hidden?: boolean;
  topicHidden?: boolean;
  // A roleplay tab's 0th post (idx -1)
  zeroth?: boolean;
};

// Seeds a one-line post by the member, in a topic of its own, stamped
// relative to the database's now().
async function seedPost(
  forumId: number,
  userId: number,
  post: SeedPost,
): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO topics (forum_id, user_id, title, is_roleplay, is_hidden)
    VALUES ($1, $2, 'A topic', false, $3)
    RETURNING id
  `,
    [forumId, userId, post.topicHidden ?? false],
  );
  await pool.query(
    `
    INSERT INTO posts
      (topic_id, user_id, markup, html, type, is_roleplay, is_hidden, idx,
       created_at)
    VALUES ($1, $2, 'hi', 'hi', 'ooc', false, $3, $4,
      now() - make_interval(secs => $5))
  `,
    [
      rows[0]!.id,
      userId,
      post.hidden ?? false,
      post.zeroth ? -1 : null,
      post.ageSeconds,
    ],
  );
}

function posts(count: number, post: SeedPost): SeedPost[] {
  return Array.from({ length: count }, () => post);
}

function startTopic(forumId: number, member: { id: number; uname: string }) {
  return forumText.createTopic(
    { ...member, slug: member.uname },
    {
      forumId,
      ipAddress: "203.0.113.7",
      title: "Hello there",
      markup: "Cheap coins at spam.example",
      postType: "ooc",
      isRoleplay: false,
      tagIds: [],
      joinStatus: undefined,
    },
  );
}

////////////////////////////////////////////////////////////

const NEW: Trust = { trusted: false, demoted: false };
const TRUSTED: Trust = { trusted: true, demoted: false };
const DEMOTED: Trust = { trusted: false, demoted: true };

// Each case is one member's rows and the standing they should read as.
const CASES: [string, { approved?: boolean; posts: SeedPost[] }, Trust][] = [
  [
    "six posts just past the floor",
    { posts: posts(6, { ageSeconds: AGED }) },
    TRUSTED,
  ],
  ["five aged posts", { posts: posts(5, { ageSeconds: AGED }) }, NEW],
  [
    "six posts just short of the floor",
    { posts: posts(6, { ageSeconds: YOUNG }) },
    NEW,
  ],
  [
    "six aged posts, one of them hidden",
    {
      posts: [
        ...posts(5, { ageSeconds: AGED }),
        { ageSeconds: AGED, hidden: true },
      ],
    },
    DEMOTED,
  ],
  [
    "six aged posts, one of them in a hidden topic",
    {
      posts: [
        ...posts(5, { ageSeconds: AGED }),
        { ageSeconds: AGED, topicHidden: true },
      ],
    },
    DEMOTED,
  ],
  [
    "six aged 0th posts",
    { posts: posts(6, { ageSeconds: AGED, zeroth: true }) },
    NEW,
  ],
  [
    "six young posts, all hidden",
    { posts: posts(6, { ageSeconds: YOUNG, hidden: true }) },
    NEW,
  ],
  ["approved, with no posts", { approved: true, posts: [] }, TRUSTED],
  ["no posts", { posts: [] }, NEW],
  [
    "a veteran with many aged posts",
    { posts: posts(30, { ageSeconds: AGED }) },
    TRUSTED,
  ],
  [
    "a veteran whose posts are all hidden",
    { posts: posts(30, { ageSeconds: AGED, hidden: true }) },
    DEMOTED,
  ],
];

async function seedMember(
  forumId: number,
  uname: string,
  seed: { approved?: boolean; posts: SeedPost[] },
): Promise<number> {
  const id = await createMember(uname, { approved: seed.approved });
  for (const post of seed.posts) await seedPost(forumId, id, post);
  return id;
}

describe("standing", () => {
  // A veteran beside every case, so a rule that counted anyone's posts would
  // trust every member.
  it.each(CASES)("reads %s", async (_label, seed, trust) => {
    const forum = await createForum();
    await seedMember(forum, "bystander", {
      posts: posts(10, { ageSeconds: AGED }),
    });
    const member = await seedMember(forum, "member", seed);

    expect(await readTrust(pool, member)).toEqual(trust);
  });

  it("reads the same in a query that lists members", async () => {
    const forum = await createForum();
    for (const [i, [_label, seed]] of CASES.entries()) {
      await seedMember(forum, `m${i}`, seed);
    }

    const { rows } = await pool.query<{ uname: string; trusted: boolean }>(`
      SELECT u.uname, ${trustedSql("u")} AS trusted
      FROM users u
      ORDER BY u.id
    `);

    expect(rows).toEqual(
      CASES.map(([_label, _seed, trust], i) => ({
        uname: `m${i}`,
        trusted: trust.trusted,
      })),
    );
  });

  it("refuses an alias that is not a plain name, or is its own", () => {
    expect(() => trustedSql("u; DROP TABLE users")).toThrow();
    expect(() => trustedSql("trust_post")).toThrow();
  });
});

describe("the spam check", () => {
  // Scenario: an account made minutes ago posts six one-line hellos in a
  // minute, so its posts_count is 6, then starts a topic.
  it("screens a member whose six posts are minutes old", async () => {
    const forum = await createForum();
    const bot = await createMember("bot");
    for (let i = 0; i < 6; i++) {
      await seedPost(forum, bot, { ageSeconds: 2 * MINUTE - i * 10 });
    }
    const { rows } = await pool.query(
      `SELECT posts_count FROM users WHERE id = $1`,
      [bot],
    );
    expect(rows).toEqual([{ posts_count: 6 }]);
    analyze.mockResolvedValue(verdict(false, 0.99));

    await startTopic(forum, { id: bot, uname: "bot" });

    expect(analyze.mock.calls.map(([charge]) => charge.body)).toEqual([
      "Cheap coins at spam.example",
    ]);
  });

  // Intent: hiding a veteran's posts sends them back to the classifier, which
  // may then only flag them for review.
  // Why it exists: one false positive on a long-time member would nuke them.
  // Scenario: staff hide every post of a veteran, who then starts a topic the
  // classifier calls spam with high confidence.
  it("screens a veteran whose posts staff hid, and never nukes them", async () => {
    const forum = await createForum();
    const vet = await seedMember(forum, "vet", {
      posts: posts(10, { ageSeconds: AGED }),
    });
    expect(await readTrust(pool, vet)).toEqual(TRUSTED);

    await pool.query(`UPDATE posts SET is_hidden = true WHERE user_id = $1`, [
      vet,
    ]);
    expect(await readTrust(pool, vet)).toEqual(DEMOTED);
    analyze.mockResolvedValue(verdict(true, 0.95));

    const { flagged } = await startTopic(forum, { id: vet, uname: "vet" });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(flagged).toBe(true);
    expect(vi.mocked(broadcastSpamReview)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(broadcastAutoNuke)).not.toHaveBeenCalled();
    const { rows } = await pool.query(
      `SELECT role, is_nuked FROM users WHERE id = $1`,
      [vet],
    );
    expect(rows).toEqual([{ role: "member", is_nuked: false }]);
  });
});
