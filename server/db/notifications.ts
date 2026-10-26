// Creates the notifications that point at a post or a topic, and is the only
// reader of their post html and topic title and of a user's list of
// subscribed topics. Each function loads its targets itself, from live rows,
// and gates them with cancan (see mayView), so a notification never shows a
// post or a topic title its recipient may not read. The raw queries stay
// private for that reason.
//
// Visibility changes after a row is written (a post is hidden, a topic moves
// into the lounge), so the reads gate again on live state and delete the rows
// that fail. A deny deletes for good, so a row the gate cannot judge throws
// before anything is deleted.
//
// Lookups by id and deletes return only pointer columns, never post html or a
// topic title, so they need no gate. Most of them stay in server/db/index.ts,
// with the convo and VM notifications, which point at neither.

// 3rd party
import assert from "assert";
import _ from "lodash";
// 1st party
import * as belt from "../belt";
import * as cancan from "../cancan";
import * as config from "../config";
import * as pre from "../presenters";
import { DbNotification } from "../dbtypes";
import {
  exactlyOneRow,
  maybeOneRow,
  pool,
  PgClientInTransaction,
} from "./util";
import { forumModsColumn } from "./readable";

////////////////////////////////////////////////////////////
// Public API

// Sends the new post's MENTION, QUOTE and TOPIC_SUB notifications, each only to
// recipients who pass the gate. Returns how many mentions and quotes were
// sent, for the create-post flash message.
export async function notifyNewPost(
  pgClient: PgClientInTransaction,
  {
    author,
    postId,
    markup,
  }: { author: { id: number; uname: string }; postId: number; markup: string },
): Promise<{ mentionsCount: number; quotesCount: number }> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(Number.isInteger(author.id), "author.id must be an integer");
  assert(typeof author.uname === "string", "author.uname must be a string");

  // Loaded through pgClient: the post is not committed yet.
  const target = targetOf(await loadPostTarget(pgClient, postId));
  assert(target.post, `post ${postId} is missing`);
  assertPost(target.post);
  const { post, topic } = target;

  // Lowercase unames, without the author's
  const mentioned = await findRecipientsByUnames(
    pgClient,
    _.take(
      belt.extractMentions(markup, author.uname),
      config.MENTIONS_PER_POST,
    ),
  );
  const quoted = await findRecipientsByUnames(
    pgClient,
    _.take(
      belt.extractQuoteMentions(markup, author.uname),
      config.QUOTES_PER_POST,
    ),
  );
  const subscribers = (await listActiveSubscribers(pgClient, topic.id)).filter(
    (u) => u.id !== author.id,
  );
  [...mentioned, ...quoted, ...subscribers].forEach(assertViewer);
  // A mention or quote shows the post, and a TOPIC_SUB the topic's title
  const mayReadPost = (u: Viewer) => mayView(u, { post, topic });
  const mayReadTopic = (u: Viewer) => mayView(u, { post: null, topic });

  const mentions = await createPostNotificationsBulk(
    pgClient,
    "MENTION",
    mentioned.filter(mayReadPost).map((u) => ({
      from_user_id: author.id,
      to_user_id: u.id,
      post_id: post.id,
      topic_id: post.topic_id,
    })),
  );
  const quotes = await createPostNotificationsBulk(
    pgClient,
    "QUOTE",
    quoted.filter(mayReadPost).map((u) => ({
      from_user_id: author.id,
      to_user_id: u.id,
      post_id: post.id,
      topic_id: post.topic_id,
    })),
  );
  await createSubNotificationsBulk(
    pgClient,
    subscribers.filter(mayReadTopic).map((u) => ({
      fromUserId: author.id,
      toUserId: u.id,
      topicId: topic.id,
      postType: post.type,
    })),
  );

  return { mentionsCount: mentions.length, quotesCount: quotes.length };
}

// Sends the post's author a RATING notification, unless the gate denies the
// author: say, after staff hid the post or moved its topic into the lounge.
// Returns it, or null when the gate denied it.
export async function notifyRating({
  fromUserId,
  postId,
  ratingType,
}: {
  fromUserId: number;
  postId: number;
  ratingType: "like" | "laugh" | "thank";
}) {
  const row = await loadRatingTarget(postId);
  const target = targetOf(row);
  assert(target.post, `post ${postId} is missing`);
  assertPost(target.post);
  assertViewer(row.author);
  if (!mayView(row.author, target)) return null;
  const { post } = target;
  return createRatingNotification({
    from_user_id: fromUserId,
    to_user_id: row.author.id,
    post_id: post.id,
    topic_id: post.topic_id,
    rating_type: ratingType,
  });
}

// The viewer's newest notifications that pass the gate, presented for
// /me/notifications. Deletes the viewer's loaded rows that fail it, and says
// how many went, overall and of TOPIC_SUB, so the caller can lower the navbar
// counters on the same render. Only the loaded window is judged, so an older
// failing row still counts until it reaches the page.
export async function listFeed(viewer: any): Promise<{
  notifications: any[];
  prunedCount: number;
  prunedSubCount: number;
}> {
  assertViewer(viewer);
  const rows = await queryFeed(viewer.id);
  // Check every row before judging any, so a bad row deletes nothing
  const loaded = rows.map((row) => {
    const target = targetOf(row);
    assertRowTarget(row, target);
    return { row, target };
  });
  const [kept, denied] = _.partition(loaded, ({ target }) =>
    mayView(viewer, target),
  );
  const prunedTypes = await prune(
    viewer.id,
    denied.map(({ row }) => row.id),
  );
  return {
    notifications: kept.map(({ row, target }) => feedNotification(row, target)),
    prunedCount: prunedTypes.length,
    prunedSubCount: prunedTypes.filter((type) => type === "TOPIC_SUB").length,
  };
}

// The viewer's subscribed topics that pass READ_TOPIC, presented, each with the
// TOPIC_SUB flags of its unread post types as topic.sub_notes. Deletes the
// viewer's TOPIC_SUB rows for the topics it drops, and says how many went. It
// keeps their subscriptions, so a topic that becomes readable again comes back;
// fan-out skips them meanwhile.
export async function listSubscribedTopics(
  viewer: any,
  isArchived: boolean,
): Promise<{ topics: any[]; prunedSubCount: number }> {
  assertViewer(viewer);
  assert(typeof isArchived === "boolean");
  const [topics, subNotes] = await Promise.all([
    findSubscribedTopics(viewer.id, isArchived),
    findSubNotifications(viewer.id),
  ]);
  topics.forEach(assertTopic);
  const [readable, unreadable] = _.partition(topics, (topic) =>
    mayView(viewer, { post: null, topic }),
  );
  const unreadableIds = new Set(unreadable.map((t) => t.id));
  const prunedTypes = await prune(
    viewer.id,
    subNotes.filter((n) => unreadableIds.has(n.topic_id)).map((n) => n.id),
  );
  for (const note of subNotes) {
    const topic = readable.find((t) => t.id === note.topic_id);
    // will have a flag for each postType that has unread posts
    // { ooc: true, ic: true, char: true }
    if (topic) topic.sub_notes = note.meta;
  }
  return {
    topics: readable.map(pre.presentTopic),
    prunedSubCount: prunedTypes.length,
  };
}

export async function deleteRatingNotification(
  pgClient: PgClientInTransaction,
  { fromUserId, postId }: { fromUserId: number; postId: number },
) {
  return pgClient
    .query<DbNotification>(
      `
    DELETE FROM notifications
    WHERE type = 'RATING'
      AND from_user_id = $1
      AND post_id = $2
    RETURNING *
    `,
      [fromUserId, postId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////
// Targets

type Target = { post: any | null; topic: any | null };

// A target's columns: the post (NULL when there is none), the topic and forum
// it sits in, and the forum's mods. READ_POST, READ_TOPIC and isTopicGm in
// server/cancan.ts read these, and the feed shows the post html and topic
// title. Expects posts as p, topics as t and forums as f.
const TARGET_COLUMNS = `
  CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object(
    'id', p.id,
    'idx', p.idx,
    'type', p.type,
    'html', p.html,
    'is_hidden', p.is_hidden,
    'user_id', p.user_id,
    'topic_id', p.topic_id
  ) END "post",
  to_json(t.*) "topic",
  to_json(f.*) "forum",
  ${forumModsColumn("t.forum_id")}`;

// Nests the target columns the way cancan reads them: READ_TOPIC takes the
// topic with its forum and mods, and READ_POST takes the post with its topic
// and forum.
function targetOf(row: any): Target {
  const topic = row.topic
    ? { ...row.topic, forum: row.forum, mods: row.mods }
    : null;
  const post = row.post ? { ...row.post, topic, forum: row.forum } : null;
  return { post, topic };
}

function loadPostTarget(pgClient: PgClientInTransaction, postId: number) {
  assert(Number.isInteger(postId), "postId must be an integer");
  return pgClient
    .query(
      `
    SELECT ${TARGET_COLUMNS}
    FROM posts p
    JOIN topics t ON t.id = p.topic_id
    JOIN forums f ON f.id = t.forum_id
    WHERE p.id = $1
  `,
      [postId],
    )
    .then(maybeOneRow)
    .then((row) => {
      assert(row, `post ${postId} is missing`);
      return row;
    });
}

// The post's target plus its author's id and role.
function loadRatingTarget(postId: number) {
  assert(Number.isInteger(postId), "postId must be an integer");
  return pool
    .query(
      `
    SELECT
      ${TARGET_COLUMNS},
      json_build_object('id', a.id, 'role', a.role) "author"
    FROM posts p
    JOIN topics t ON t.id = p.topic_id
    JOIN forums f ON f.id = t.forum_id
    JOIN users a ON a.id = p.user_id
    WHERE p.id = $1
  `,
      [postId],
    )
    .then(maybeOneRow)
    .then((row) => {
      assert(row, `post ${postId} is missing`);
      return row;
    });
}

////////////////////////////////////////////////////////////
// Gate

type Viewer = { id: number; role: string };

// Keys on the row's pointers, not its type, so a new type that carries a post
// or a topic is gated without a list to keep in sync. A row with a post shows
// the post and its topic's title, so READ_POST decides; it owns the lounge and
// hidden-topic rules for posts, including that a GM may read every post in
// their topic. A row with only a topic shows its title, so READ_TOPIC decides.
// A row with neither (CONVO, PM, VM) passes: its recipient was a participant
// or the VM's owner when it was written.
function mayView(viewer: Viewer, target: Target): boolean {
  if (target.post) return cancan.can(viewer, "READ_POST", target.post);
  if (target.topic) return cancan.can(viewer, "READ_TOPIC", target.topic);
  return true;
}

// A viewer without a role would read as a guest and be denied.
function assertViewer(viewer: any): asserts viewer is Viewer {
  assert(viewer, "viewer is missing");
  assert(Number.isInteger(viewer.id), "viewer.id must be an integer");
  assert(typeof viewer.role === "string", "viewer.role must be a string");
}

// The fields READ_TOPIC and isTopicGm read. cancan reads a missing one as
// "not hidden" or "no mods", which would allow or deny wrongly.
function assertTopic(topic: any) {
  assert(Number.isInteger(topic.id), "topic.id must be an integer");
  assert(Number.isInteger(topic.forum_id), "topic.forum_id must be an integer");
  assert(Number.isInteger(topic.user_id), "topic.user_id must be an integer");
  assert(
    typeof topic.is_hidden === "boolean",
    "topic.is_hidden must be a boolean",
  );
  assert(Array.isArray(topic.co_gm_ids), "topic.co_gm_ids must be an array");
  assert(Array.isArray(topic.mods), "topic.mods must be an array");
  assert(topic.forum, "topic.forum is missing");
  assert(
    Number.isInteger(topic.forum.category_id),
    "topic.forum.category_id must be an integer",
  );
}

// The fields READ_POST reads, its topic's included.
function assertPost(post: any) {
  assert(Number.isInteger(post.id), "post.id must be an integer");
  assert(
    typeof post.is_hidden === "boolean",
    "post.is_hidden must be a boolean",
  );
  assert(Number.isInteger(post.user_id), "post.user_id must be an integer");
  assert(post.topic, "post.topic is missing");
  assert(post.forum, "post.forum is missing");
  assert(post.topic_id === post.topic.id, "post.topic is not the post's topic");
  assertTopic(post.topic);
}

// A row's target must be the one it points at, with every field the gate
// reads. The pointer columns' foreign keys cascade and a post never changes
// topic, so a failure means a query drifted from what cancan reads.
function assertRowTarget(n: any, target: Target) {
  assert(
    n.post_id === null || Number.isInteger(n.post_id),
    `notification ${n.id}: post_id must be an integer or null`,
  );
  assert(
    n.topic_id === null || Number.isInteger(n.topic_id),
    `notification ${n.id}: topic_id must be an integer or null`,
  );
  if (n.post_id !== null) {
    assert(target.post, `notification ${n.id}: post is missing`);
    assert(target.post.id === n.post_id, `notification ${n.id}: wrong post`);
    assertPost(target.post);
  }
  if (n.topic_id !== null) {
    assert(target.topic, `notification ${n.id}: topic is missing`);
    // The topic loaded is the post's own, so this also says the row's topic
    // title is the one READ_POST gated
    assert(
      target.topic.id === n.topic_id,
      `notification ${n.id}: topic_id is not its post's topic`,
    );
    assertTopic(target.topic);
  }
}

// Deletes the viewer's rows the gate denied. The users counters follow by
// trigger. Returns the deleted rows' types, so callers lower the loaded user's
// counters by what actually went.
async function prune(toUserId: number, ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return pool
    .query<{ type: string }>(
      `
    DELETE FROM notifications
    WHERE to_user_id = $1
      AND id = ANY ($2::int[])
    RETURNING type
  `,
      [toUserId, ids],
    )
    .then((res) => res.rows.map((row) => row.type));
}

////////////////////////////////////////////////////////////
// Recipients

// Case-insensitive. Only the fields cancan reads.
async function findRecipientsByUnames(
  pgClient: PgClientInTransaction,
  unames: string[],
): Promise<Array<{ id: number; role: string }>> {
  assert(_.every(unames, _.isString));
  if (unames.length === 0) return [];
  return pgClient
    .query<{ id: number; role: string }>(
      `
    SELECT u.id, u.role
    FROM users u
    WHERE lower(u.uname) = ANY ($1::text[])
  `,
      [unames.map((s) => s.toLowerCase())],
    )
    .then((res) => res.rows);
}

// Subscribers who have not archived the topic
function listActiveSubscribers(
  pgClient: PgClientInTransaction,
  topicId: number,
) {
  assert(Number.isInteger(topicId));
  return pgClient
    .query<{ id: number; role: string }>(
      `
    SELECT u.id, u.role
    FROM users u
    JOIN topic_subscriptions ts ON u.id = ts.user_id
    WHERE ts.topic_id = $1
      AND ts.is_archived = false
  `,
      [topicId],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////
// Writes

// A recipient gets one MENTION and one QUOTE per post at most.
async function createPostNotificationsBulk(
  pgClient: PgClientInTransaction,
  type: "MENTION" | "QUOTE",
  notifications: Array<{
    from_user_id: number;
    to_user_id: number;
    post_id: number;
    topic_id: number;
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(["MENTION", "QUOTE"].includes(type));
  if (notifications.length === 0) return [];

  // Validate all inputs
  notifications.forEach(({ from_user_id, to_user_id, post_id, topic_id }) => {
    assert(from_user_id);
    assert(to_user_id);
    assert(post_id);
    assert(topic_id);
  });

  const fromUserIds = notifications.map((n) => n.from_user_id);
  const toUserIds = notifications.map((n) => n.to_user_id);
  const topicIds = notifications.map((n) => n.topic_id);
  const postIds = notifications.map((n) => n.post_id);

  // The type goes into the SQL text, not a param, because ON CONFLICT names
  // the partial unique index by its predicate.
  return pgClient
    .query<{ id: number }>(
      `
    INSERT INTO notifications (type, from_user_id, to_user_id, topic_id, post_id)
    SELECT
      '${type}',
      unnest($1::int[]),
      unnest($2::int[]),
      unnest($3::int[]),
      unnest($4::int[])
    ON CONFLICT (to_user_id, post_id) WHERE type = '${type}'
      DO NOTHING
    RETURNING *
    `,
      [fromUserIds, toUserIds, topicIds, postIds],
    )
    .then((result) => result.rows);
}

// sub notes have a meta that looks like {ic: true, ooc: true, char: true}
// which indicates which postType the notification has accumulated new
// posts for.
async function createSubNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    fromUserId: number;
    toUserId: number;
    topicId: number;
    postType: "ic" | "ooc" | "char";
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return;

  // Validate all inputs
  notifications.forEach(({ fromUserId, toUserId, topicId, postType }) => {
    assert(["ic", "ooc", "char"].includes(postType));
    assert(Number.isInteger(topicId));
    assert(Number.isInteger(fromUserId));
    assert(Number.isInteger(toUserId));
  });

  const fromUserIds = notifications.map((n) => n.fromUserId);
  const toUserIds = notifications.map((n) => n.toUserId);
  const topicIds = notifications.map((n) => n.topicId);
  const metas = notifications.map((n) => ({ [n.postType]: true }));

  return pgClient
    .query<DbNotification>(
      `
    INSERT INTO notifications (type, from_user_id, to_user_id, topic_id, meta, count)
    SELECT
      'TOPIC_SUB',
      unnest($1::int[]),
      unnest($2::int[]),
      unnest($3::int[]),
      unnest($4::jsonb[]),
      1
    ON CONFLICT (to_user_id, topic_id) WHERE type = 'TOPIC_SUB'
      DO UPDATE
      SET count = COALESCE(notifications.count, 0) + 1,
          meta = notifications.meta || EXCLUDED.meta,
          updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
      [fromUserIds, toUserIds, topicIds, metas],
    )
    .then((res) => res.rows);
}

// One RATING per rater and post: a new rating replaces the old one's type.
function createRatingNotification(props: {
  from_user_id: number;
  to_user_id: number;
  post_id: number;
  topic_id: number;
  rating_type: "like" | "laugh" | "thank";
}) {
  assert(props.from_user_id);
  assert(props.to_user_id);
  assert(props.post_id);
  assert(props.topic_id);
  assert(props.rating_type);

  return pool
    .query<DbNotification>(
      `
INSERT INTO notifications
(type, from_user_id, to_user_id, meta, post_id, topic_id)
VALUES ('RATING', $1, $2, $3, $4, $5)
ON CONFLICT (from_user_id, post_id) WHERE type = 'RATING' DO UPDATE
    SET updated_at = NOW(),
        meta = $3
RETURNING *
  `,
      [
        props.from_user_id, // $1
        props.to_user_id, // $2
        { type: props.rating_type }, // $3
        props.post_id, // $4
        props.topic_id, // $5
      ],
    )
    .then(exactlyOneRow);
}

////////////////////////////////////////////////////////////
// Reads

// The newest 50, with each row's target
function queryFeed(toUserId: number) {
  assert(Number.isInteger(toUserId));
  return pool
    .query(
      `
SELECT
  n.*,
  to_json(u.*) "from_user",
  CASE
    WHEN n.convo_id IS NOT NULL
    THEN
      json_build_object (
        'id', n.convo_id,
        'title', c.title
      )
  END "convo",
  CASE
    WHEN n.vm_id IS NOT NULL
    THEN
      json_build_object (
        'id', n.vm_id,
        'html', vms.html
      )
  END "vm",
  ${TARGET_COLUMNS}
FROM notifications n
JOIN users u ON n.from_user_id = u.id
LEFT OUTER JOIN convos c ON n.convo_id = c.id
LEFT OUTER JOIN vms ON n.vm_id = vms.id
LEFT OUTER JOIN posts p ON n.post_id = p.id
LEFT OUTER JOIN topics t ON t.id = COALESCE(p.topic_id, n.topic_id)
LEFT OUTER JOIN forums f ON t.forum_id = f.id
WHERE n.to_user_id = $1
ORDER BY n.id DESC
LIMIT 50
  `,
      [toUserId],
    )
    .then((res) => res.rows);
}

// The template reads n.post (html, url) and n.topic (title, url).
function feedNotification(row: any, target: Target) {
  return pre.presentNotification({
    ..._.omit(row, ["forum", "mods"]),
    post: target.post,
    topic: target.topic,
  });
}

function findSubNotifications(toUserId: number) {
  assert(Number.isInteger(toUserId));
  return pool
    .query<DbNotification & { topic_id: number; meta: any }>(
      `
    SELECT *
    FROM notifications
    WHERE to_user_id = $1
      AND type = 'TOPIC_SUB'
  `,
      [toUserId],
    )
    .then((res) => res.rows);
}

// Sort them by latest_posts first
function findSubscribedTopics(userId: number, isArchived: boolean) {
  assert(Number.isInteger(userId));
  assert(typeof isArchived === "boolean");

  return pool
    .query(
      `
SELECT
  t.*,
  json_build_object(
    'uname', u.uname,
    'slug', u.slug
  ) "user",

  json_build_object(
    'id', latest_post.id,
    'created_at', latest_post.created_at
  ) "latest_post",

  json_build_object(
    'uname', u2.uname,
    'slug', u2.slug
  ) "latest_user",

  CASE
    WHEN latest_ic_post IS NULL THEN NULL
    ELSE
      json_build_object(
        'id', latest_ic_post.id,
        'created_at', latest_ic_post.created_at
      )
  END "latest_ic_post",

  CASE
    WHEN latest_ic_user IS NULL THEN NULL
    ELSE
      json_build_object(
        'uname', latest_ic_user.uname,
        'slug', latest_ic_user.slug
      )
  END "latest_ic_user",

  CASE
    WHEN latest_ooc_post IS NULL THEN NULL
    ELSE
      json_build_object(
        'id', latest_ooc_post.id,
        'created_at', latest_ooc_post.created_at
      )
  END "latest_ooc_post",

  CASE
    WHEN latest_ooc_user IS NULL THEN NULL
    ELSE
      json_build_object(
        'uname', latest_ooc_user.uname,
        'slug', latest_ooc_user.slug
      )
  END "latest_ooc_user",

  CASE
    WHEN latest_char_post IS NULL THEN NULL
    ELSE
      json_build_object(
        'id', latest_char_post.id,
        'created_at', latest_char_post.created_at
      )
  END "latest_char_post",

  CASE
    WHEN latest_char_user IS NULL THEN NULL
    ELSE
      json_build_object(
        'uname', latest_char_user.uname,
        'slug', latest_char_user.slug
      )
  END "latest_char_user",

  to_json(f.*) "forum",
  ${forumModsColumn("t.forum_id")},
  ts.is_archived
FROM topic_subscriptions ts
JOIN topics t ON ts.topic_id = t.id
JOIN users u ON t.user_id = u.id
LEFT OUTER JOIN posts latest_post ON t.latest_post_id = latest_post.id
LEFT OUTER JOIN posts latest_ic_post ON t.latest_ic_post_id = latest_ic_post.id
LEFT OUTER JOIN users latest_ic_user ON latest_ic_post.user_id = latest_ic_user.id
LEFT OUTER JOIN posts latest_ooc_post ON t.latest_ooc_post_id = latest_ooc_post.id
LEFT OUTER JOIN users latest_ooc_user ON latest_ooc_post.user_id = latest_ooc_user.id
LEFT OUTER JOIN posts latest_char_post ON t.latest_char_post_id = latest_char_post.id
LEFT OUTER JOIN users latest_char_user ON latest_char_post.user_id = latest_char_user.id
JOIN users u2 ON latest_post.user_id = u2.id
JOIN forums f ON t.forum_id = f.id
WHERE ts.user_id = $1
  AND is_archived = $2
ORDER BY t.latest_post_id DESC
  `,
      [userId, isArchived],
    )
    .then((res) => res.rows);
}
