import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "./util";
import {
  listFeed,
  listSubscribedTopics,
  notifyNewPost,
  notifyRating,
} from "./notifications";

// Intent: a notification never shows a post or a topic title its recipient
// may not read. Fan-out skips recipients cancan denies, and the feed and the
// subscriptions list drop and delete rows that fail the gate on live state.
// Why it exists: staff who mentioned or quoted a member in a Lexus Lounge post
// sent that member the post html and the lounge topic title, and posts hidden
// or moved into the lounge later stayed readable through old notifications.
// Scenario: a mod mentions and quotes Member in a lounge thread about Member,
// which Member was subscribed to before it moved into the lounge.

// The repo has no real-database tests. This stub answers each query from the
// tables below, by what its SQL selects: a post carries only the keys its
// json_build_object names, a user only the columns its SELECT names, and a
// topic its mods only when the SQL reads forum_mods. So a query that drops a
// column the gate needs returns a short row.
vi.mock("./util", () => ({
  pool: { query: vi.fn() },
  maybeOneRow: (res: { rows: unknown[] }) => res.rows[0],
  exactlyOneRow: (res: { rows: unknown[] }) => res.rows[0],
}));

////////////////////////////////////////////////////////////
// Fixtures

const loungeForum = { id: 10, title: "Mod Forum", category_id: 4 };
const publicForum = { id: 3, title: "Free Roleplay", category_id: 2 };
const forums = [loungeForum, publicForum];

const member = { id: 1, uname: "Member", slug: "member", role: "member" };
const gm = { id: 50, uname: "Gm", slug: "gm", role: "member" };
const forumMod = {
  id: 7,
  uname: "Forum Mod",
  slug: "forum-mod",
  role: "member",
};
const mod = { id: 30, uname: "Mod", slug: "mod", role: "mod" };
const smod = { id: 31, uname: "Smod", slug: "smod", role: "smod" };
const users = [member, gm, forumMod, mod, smod];

const forumMods = [{ forum_id: publicForum.id, user_id: forumMod.id }];

function topicFixture(props: {
  id: number;
  title: string;
  forum_id: number;
  user_id?: number;
  is_hidden?: boolean;
}) {
  return {
    user_id: gm.id,
    co_gm_ids: [] as number[],
    is_hidden: false,
    is_closed: false,
    created_at: "2026-01-01T00:00:00Z",
    ...props,
  };
}

const loungeTopic = topicFixture({
  id: 123,
  title: "What to do about Member",
  forum_id: loungeForum.id,
  user_id: mod.id,
});
// Hidden by a mod. Gm runs it.
const modHiddenTopic = topicFixture({
  id: 124,
  title: "Gm's hidden quest",
  forum_id: publicForum.id,
  is_hidden: true,
});
const publicTopic = topicFixture({
  id: 125,
  title: "A visible roleplay",
  forum_id: publicForum.id,
});
const topics = [loungeTopic, modHiddenTopic, publicTopic];

function postFixture(props: {
  id: number;
  topic_id: number;
  user_id: number;
  is_hidden?: boolean;
}) {
  return {
    idx: 0,
    type: "ooc",
    is_hidden: false,
    html: `<p>post ${props.id}</p>`,
    ...props,
  };
}

const loungePost = postFixture({
  id: 1001,
  topic_id: loungeTopic.id,
  user_id: mod.id,
});
const modHiddenTopicPost = postFixture({
  id: 1002,
  topic_id: modHiddenTopic.id,
  user_id: member.id,
});
const publicPost = postFixture({
  id: 1003,
  topic_id: publicTopic.id,
  user_id: member.id,
});
const hiddenPost = postFixture({
  id: 1004,
  topic_id: publicTopic.id,
  user_id: member.id,
  is_hidden: true,
});
// Member's post in the thread staff moved into the lounge
const movedPost = postFixture({
  id: 1005,
  topic_id: loungeTopic.id,
  user_id: member.id,
});
const posts = [
  loungePost,
  modHiddenTopicPost,
  publicPost,
  hiddenPost,
  movedPost,
];

////////////////////////////////////////////////////////////
// Fake database

type Row = Record<string, any>;

// Reset before each test
let db: {
  notifications: Row[];
  subscriptions: Array<{
    user_id: number;
    topic_id: number;
    is_archived: boolean;
  }>;
  // Created inside the open transaction, so only pgClient sees them
  pendingPosts: Row[];
  // Rows each INSERT INTO notifications wrote, in order
  inserted: Row[];
  // Damages the feed row with this notification id, to test the shape check
  corrupt: { id: number; damage: (row: Row) => void } | null;
  nextId: number;
};

function notification(props: Row): Row {
  return {
    id: db.nextId++,
    from_user_id: mod.id,
    topic_id: null,
    post_id: null,
    convo_id: null,
    vm_id: null,
    meta: null,
    count: null,
    ...props,
  };
}

function modsColumn(sql: string, forumId: number | null) {
  if (!/FROM forum_mods\b/.test(sql)) return {};
  return {
    mods: forumMods
      .filter((m) => m.forum_id === forumId)
      .map((m) => {
        const u = users.find((u) => u.id === m.user_id)!;
        return { id: u.id, uname: u.uname, slug: u.slug };
      }),
  };
}

// Emulates json_build_object('key', p.col, ...): only the named keys.
function postColumns(sql: string, post: Row) {
  const pairs = [...sql.matchAll(/'(\w+)', p\.(\w+)/g)];
  return Object.fromEntries(pairs.map(([, key, col]) => [key, post[col!]]));
}

function targetColumns(sql: string, post: Row | null, topic: Row | null) {
  const forum = topic ? forums.find((f) => f.id === topic.forum_id)! : null;
  return {
    post: post ? postColumns(sql, post) : null,
    topic: topic ? { ...topic, co_gm_ids: [...topic.co_gm_ids] } : null,
    forum: forum ? { ...forum } : null,
    ...modsColumn(sql, topic ? topic.forum_id : null),
  };
}

// Emulates the feed's topic join, so a row with a post and no topic_id gets
// the topic the SQL would give it.
function feedTopicId(sql: string, post: Row | null, n: Row) {
  const on = /JOIN topics t ON t\.id = (.+)/.exec(sql)![1]!.trim();
  if (on === "COALESCE(p.topic_id, n.topic_id)") {
    return post ? post.topic_id : n.topic_id;
  }
  if (on === "n.topic_id") return n.topic_id;
  if (on === "p.topic_id") return post ? post.topic_id : null;
  throw new Error(`fake database has no answer for the topic join: ${on}`);
}

// Emulates SELECT u.a, u.b FROM users u: only the named columns.
function userColumns(sql: string, user: Row) {
  const list = /SELECT\s+([\s\S]*?)\s+FROM users u\b/.exec(sql)![1]!;
  const cols = list.split(",").map((s) => s.trim().replace(/^u\./, ""));
  return Object.fromEntries(cols.map((c) => [c, user[c]]));
}

function insertNotifications(sql: string, params: unknown[]) {
  const cols = /INSERT INTO notifications\s*\(([^)]*)\)/
    .exec(sql)![1]!
    .split(",")
    .map((s) => s.trim());
  const type = /'(MENTION|QUOTE|TOPIC_SUB|RATING)'/.exec(sql)![1];
  // The type is a literal in the SQL; the params fill the next columns.
  const valueCols = cols.slice(1, 1 + params.length);
  const width = Array.isArray(params[0]) ? params[0].length : 1;
  const rows = Array.from({ length: width }, (_, i) => {
    const row: Row = notification({ type });
    valueCols.forEach((col, j) => {
      const param = params[j];
      row[col] = Array.isArray(param) ? param[i] : param;
    });
    return row;
  });
  db.inserted.push(...rows);
  db.notifications.push(...rows);
  return rows;
}

function answer(sql: string, params: unknown[], inTransaction: boolean) {
  // One post's target, for fan-out and ratings
  if (/FROM posts p\s+JOIN topics t[\s\S]*WHERE p\.id = \$1/.test(sql)) {
    const visible = inTransaction ? [...posts, ...db.pendingPosts] : posts;
    const post = visible.find((p) => p.id === params[0]);
    if (!post) return [];
    const topic = topics.find((t) => t.id === post.topic_id)!;
    const author = users.find((u) => u.id === post.user_id)!;
    return [
      {
        ...targetColumns(sql, post, topic),
        ...(/"author"/.test(sql)
          ? { author: { id: author.id, role: author.role } }
          : {}),
      },
    ];
  }
  if (/FROM users u\s+WHERE lower\(u\.uname\) = ANY/.test(sql)) {
    const unames = params[0] as string[];
    return users
      .filter((u) => unames.includes(u.uname.toLowerCase()))
      .map((u) => userColumns(sql, u));
  }
  if (/JOIN topic_subscriptions ts ON u\.id = ts\.user_id/.test(sql)) {
    return db.subscriptions
      .filter((s) => s.topic_id === params[0] && !s.is_archived)
      .map((s) => userColumns(sql, users.find((u) => u.id === s.user_id)!));
  }
  if (/^\s*INSERT INTO notifications/.test(sql)) {
    return insertNotifications(sql, params);
  }
  // The feed
  if (/FROM notifications n\b[\s\S]*WHERE n\.to_user_id = \$1/.test(sql)) {
    return db.notifications
      .filter((n) => n.to_user_id === params[0])
      .sort((a, b) => b.id - a.id)
      .slice(0, 50)
      .map((n) => {
        const post = posts.find((p) => p.id === n.post_id) ?? null;
        const topicId = feedTopicId(sql, post, n);
        const topic = topics.find((t) => t.id === topicId) ?? null;
        const row: Row = {
          ...n,
          from_user: { ...users.find((u) => u.id === n.from_user_id)! },
          convo: n.convo_id ? { id: n.convo_id, title: "A convo" } : null,
          vm: n.vm_id ? { id: n.vm_id, html: "<p>A vm</p>" } : null,
          ...targetColumns(sql, post, topic),
        };
        if (db.corrupt && db.corrupt.id === n.id) db.corrupt.damage(row);
        return row;
      });
  }
  if (
    /FROM notifications\s+WHERE to_user_id = \$1\s+AND type = 'TOPIC_SUB'/.test(
      sql,
    )
  ) {
    return db.notifications.filter(
      (n) => n.to_user_id === params[0] && n.type === "TOPIC_SUB",
    );
  }
  if (/FROM topic_subscriptions ts\s+JOIN topics t\b/.test(sql)) {
    const [userId, isArchived] = params;
    return db.subscriptions
      .filter((s) => s.user_id === userId && s.is_archived === isArchived)
      .map((s) => {
        const topic = topics.find((t) => t.id === s.topic_id)!;
        const forum = forums.find((f) => f.id === topic.forum_id)!;
        return {
          ...topic,
          co_gm_ids: [...topic.co_gm_ids],
          user: { uname: gm.uname, slug: gm.slug },
          forum: { ...forum },
          ...modsColumn(sql, topic.forum_id),
          is_archived: s.is_archived,
        };
      });
  }
  if (
    /^\s*DELETE FROM notifications\s+WHERE to_user_id = \$1\s+AND id = ANY \(\$2/.test(
      sql,
    )
  ) {
    const [toUserId, ids] = params as [number, number[]];
    const gone = db.notifications.filter(
      (n) => n.to_user_id === toUserId && ids.includes(n.id),
    );
    db.notifications = db.notifications.filter((n) => !gone.includes(n));
    return gone;
  }
  throw new Error(`fake database has no answer for: ${sql}`);
}

async function query(
  inTransaction: boolean,
  sql: string,
  params: unknown[] = [],
) {
  const rows = answer(sql, params, inTransaction);
  return { rows, rowCount: rows.length };
}

const pgClient = {
  _inTransaction: true,
  query: vi.fn((sql: string, params?: unknown[]) => query(true, sql, params)),
} as any;

beforeEach(() => {
  db = {
    notifications: [],
    subscriptions: [],
    pendingPosts: [],
    inserted: [],
    corrupt: null,
    nextId: 5000,
  };
  vi.mocked(pool.query).mockReset();
  vi.mocked(pool.query).mockImplementation(((sql: string, params?: unknown[]) =>
    query(false, sql, params)) as any);
});

function recipients(type: string) {
  return db.inserted.filter((n) => n.type === type).map((n) => n.to_user_id);
}

////////////////////////////////////////////////////////////

describe("notifyNewPost", () => {
  it("pings staff but not a member named in a lounge post", async () => {
    const newPost = postFixture({
      id: 2001,
      topic_id: loungeTopic.id,
      user_id: mod.id,
    });
    db.pendingPosts.push(newPost);
    db.subscriptions.push(
      { user_id: member.id, topic_id: loungeTopic.id, is_archived: false },
      { user_id: smod.id, topic_id: loungeTopic.id, is_archived: false },
    );

    const counts = await notifyNewPost(pgClient, {
      author: mod,
      postId: newPost.id,
      markup:
        "[@Member] and [@Smod], see [quote=Member]my report[/quote] " +
        "and [quote=Smod]agreed[/quote]",
    });

    expect(recipients("MENTION")).toEqual([smod.id]);
    expect(recipients("QUOTE")).toEqual([smod.id]);
    expect(recipients("TOPIC_SUB")).toEqual([smod.id]);
    expect(counts).toEqual({ mentionsCount: 1, quotesCount: 1 });
  });

  it("pings a member named in a public post", async () => {
    const newPost = postFixture({
      id: 2002,
      topic_id: publicTopic.id,
      user_id: mod.id,
    });
    db.pendingPosts.push(newPost);
    db.subscriptions.push({
      user_id: member.id,
      topic_id: publicTopic.id,
      is_archived: false,
    });

    await notifyNewPost(pgClient, {
      author: mod,
      postId: newPost.id,
      markup: "[@Member] [quote=Member]hi[/quote]",
    });

    expect(recipients("MENTION")).toEqual([member.id]);
    expect(recipients("QUOTE")).toEqual([member.id]);
    expect(recipients("TOPIC_SUB")).toEqual([member.id]);
  });
});

describe("notifyRating", () => {
  it("does not tell a member about a rating on their post in the lounge", async () => {
    await notifyRating({
      fromUserId: mod.id,
      postId: movedPost.id,
      ratingType: "like",
    });

    expect(db.inserted).toEqual([]);
  });

  it("tells a member about a rating on their public post", async () => {
    await notifyRating({
      fromUserId: mod.id,
      postId: publicPost.id,
      ratingType: "like",
    });

    expect(recipients("RATING")).toEqual([member.id]);
  });
});

describe("listFeed", () => {
  type Case = [string, Row, () => Row, boolean];
  const cases: Case[] = [
    [
      "a member's mention in a public post",
      member,
      () => ({
        type: "MENTION",
        post_id: publicPost.id,
        topic_id: publicTopic.id,
      }),
      true,
    ],
    [
      "a member's mention in a lounge post",
      member,
      () => ({
        type: "MENTION",
        post_id: loungePost.id,
        topic_id: loungeTopic.id,
      }),
      false,
    ],
    [
      "a member's quote in a hidden post",
      member,
      () => ({
        type: "QUOTE",
        post_id: hiddenPost.id,
        topic_id: publicTopic.id,
      }),
      false,
    ],
    [
      "a member's rating on their post moved into the lounge",
      member,
      () => ({
        type: "RATING",
        post_id: movedPost.id,
        topic_id: loungeTopic.id,
      }),
      false,
    ],
    // A post and no topic_id, the shape
    // server/db/admin.ts#createGuildUpdateNotifications writes. The topic the
    // gate reads comes from the post.
    [
      "a member's update about a public post, with no topic_id",
      member,
      () => ({ type: "GUILD_UPDATE", post_id: publicPost.id }),
      true,
    ],
    [
      "a member's update about a lounge post, with no topic_id",
      member,
      () => ({ type: "GUILD_UPDATE", post_id: loungePost.id }),
      false,
    ],
    [
      "a member's new posts in a public topic",
      member,
      () => ({
        type: "TOPIC_SUB",
        topic_id: publicTopic.id,
        meta: { ooc: true },
      }),
      true,
    ],
    [
      "a member's new posts in a lounge topic",
      member,
      () => ({
        type: "TOPIC_SUB",
        topic_id: loungeTopic.id,
        meta: { ooc: true },
      }),
      false,
    ],
    [
      "a member's new posts in a mod-hidden topic",
      member,
      () => ({
        type: "TOPIC_SUB",
        topic_id: modHiddenTopic.id,
        meta: { ooc: true },
      }),
      false,
    ],
    [
      "a member's unread convo",
      member,
      () => ({ type: "CONVO", convo_id: 9 }),
      true,
    ],
    [
      "a member's visitor message",
      member,
      () => ({ type: "TOPLEVEL_VM", vm_id: 8 }),
      true,
    ],
    // READ_POST lets a GM read every post in their topic, even a mod-hidden one
    [
      "a GM's mention in their mod-hidden topic",
      gm,
      () => ({
        type: "MENTION",
        post_id: modHiddenTopicPost.id,
        topic_id: modHiddenTopic.id,
      }),
      true,
    ],
    // READ_TOPIC has no GM rule
    [
      "a GM's new posts in their mod-hidden topic",
      gm,
      () => ({
        type: "TOPIC_SUB",
        topic_id: modHiddenTopic.id,
        meta: { ooc: true },
      }),
      false,
    ],
    // Read live from forum_mods
    [
      "a forum mod's new posts in a hidden topic of their forum",
      forumMod,
      () => ({
        type: "TOPIC_SUB",
        topic_id: modHiddenTopic.id,
        meta: { ooc: true },
      }),
      true,
    ],
    [
      "a mod's mention in a lounge post",
      mod,
      () => ({
        type: "MENTION",
        post_id: loungePost.id,
        topic_id: loungeTopic.id,
      }),
      true,
    ],
  ];

  const titled = cases.map(
    ([label, viewer, props, kept]) => [label, kept, viewer, props] as const,
  );

  it.each(titled)("%s: kept is %s", async (_label, kept, viewer, props) => {
    const n = notification({ to_user_id: viewer.id, ...props() });
    db.notifications.push(n);

    const feed = await listFeed(viewer);

    expect(feed.notifications.map((x) => x.id)).toEqual(kept ? [n.id] : []);
    expect(db.notifications.map((x) => x.id)).toEqual(kept ? [n.id] : []);
    expect(feed.prunedCount).toBe(kept ? 0 : 1);
    expect(feed.prunedSubCount).toBe(!kept && n.type === "TOPIC_SUB" ? 1 : 0);
  });

  it("keeps readable rows in order with what the page shows", async () => {
    const rows = [
      notification({ to_user_id: member.id, type: "CONVO", convo_id: 9 }),
      notification({
        to_user_id: member.id,
        type: "MENTION",
        post_id: loungePost.id,
        topic_id: loungeTopic.id,
      }),
      notification({
        to_user_id: member.id,
        type: "MENTION",
        post_id: publicPost.id,
        topic_id: publicTopic.id,
      }),
      notification({
        to_user_id: member.id,
        type: "TOPIC_SUB",
        topic_id: loungeTopic.id,
        meta: { ooc: true },
      }),
    ];
    db.notifications.push(...rows);
    const [convo, , publicMention] = rows;

    const feed = await listFeed(member);

    expect(feed.notifications.map((x) => x.id)).toEqual([
      publicMention!.id,
      convo!.id,
    ]);
    expect(feed.prunedCount).toBe(2);
    expect(feed.prunedSubCount).toBe(1);
    const shown = feed.notifications[0]!;
    expect(shown.post.html).toBe(publicPost.html);
    expect(shown.post.url).toBe(`/posts/${publicPost.id}`);
    expect(shown.topic.title).toBe(publicTopic.title);
  });

  // A deny deletes for good, so a row the gate cannot judge must throw before
  // anything is deleted, not read as a deny.
  type Damage = [string, () => Row, (row: Row) => void, RegExp];
  const damages: Damage[] = [
    [
      "a topic without mods",
      () => ({ type: "TOPIC_SUB", topic_id: modHiddenTopic.id }),
      (row) => delete row.mods,
      /topic\.mods must be an array/,
    ],
    [
      "a topic without co_gm_ids",
      () => ({ type: "TOPIC_SUB", topic_id: modHiddenTopic.id }),
      (row) => delete row.topic.co_gm_ids,
      /topic\.co_gm_ids must be an array/,
    ],
    [
      "a post without is_hidden",
      () => ({
        type: "MENTION",
        post_id: publicPost.id,
        topic_id: publicTopic.id,
      }),
      (row) => delete row.post.is_hidden,
      /post\.is_hidden must be a boolean/,
    ],
    [
      "a topic_id that is not its post's topic",
      () => ({
        type: "MENTION",
        post_id: loungePost.id,
        topic_id: publicTopic.id,
      }),
      () => {},
      /topic_id is not its post's topic/,
    ],
  ];

  it.each(damages)(
    "throws on %s and deletes nothing",
    async (_label, props, damage, message) => {
      // Oldest, so the gate reaches it last
      const bad = notification({ to_user_id: forumMod.id, ...props() });
      const deniable = notification({
        to_user_id: forumMod.id,
        type: "MENTION",
        post_id: loungePost.id,
        topic_id: loungeTopic.id,
      });
      db.notifications.push(bad, deniable);
      db.corrupt = { id: bad.id, damage };

      await expect(listFeed(forumMod)).rejects.toThrow(message);

      expect(db.notifications.map((x) => x.id)).toEqual([bad.id, deniable.id]);
    },
  );
});

describe("listSubscribedTopics", () => {
  it("drops a member's lounge and hidden topics and deletes their TOPIC_SUB rows", async () => {
    for (const topic of [publicTopic, loungeTopic, modHiddenTopic]) {
      db.subscriptions.push({
        user_id: member.id,
        topic_id: topic.id,
        is_archived: false,
      });
      db.notifications.push(
        notification({
          to_user_id: member.id,
          type: "TOPIC_SUB",
          topic_id: topic.id,
          meta: { ic: true },
        }),
      );
    }
    const subscriptionsBefore = [...db.subscriptions];

    const { topics, prunedSubCount } = await listSubscribedTopics(
      member,
      false,
    );

    expect(topics.map((t) => t.id)).toEqual([publicTopic.id]);
    expect(topics[0]!.sub_notes).toEqual({ ic: true });
    expect(db.notifications.map((n) => n.topic_id)).toEqual([publicTopic.id]);
    expect(prunedSubCount).toBe(2);
    // The subscriptions stay, so a topic that becomes readable comes back
    expect(db.subscriptions).toEqual(subscriptionsBefore);
  });

  it("keeps a hidden topic for a mod of its forum", async () => {
    db.subscriptions.push({
      user_id: forumMod.id,
      topic_id: modHiddenTopic.id,
      is_archived: true,
    });

    const { topics, prunedSubCount } = await listSubscribedTopics(
      forumMod,
      true,
    );

    expect(topics.map((t) => t.id)).toEqual([modHiddenTopic.id]);
    expect(prunedSubCount).toBe(0);
  });
});
