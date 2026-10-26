// The only way to load a topic or forum row by id. Each loader checks
// READ_TOPIC or READ_FORUM before it hands the row back, so no handler can
// redirect to, render or act on a row whose read check it skipped. The raw
// queries stay private to this file for that reason.
//
// List queries stay in server/db/index.ts, because they filter in SQL. Post
// rows stay there too, because READ_POST guards them.

// 3rd party
import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db:readable");
// 1st party
import * as cancan from "../cancan";
import * as pre from "../presenters";
import { pool, maybeOneRow } from "./util";

////////////////////////////////////////////////////////////

// Each shape names the query a handler loaded before this module existed, so
// a handler keeps the columns it reads.
export type TopicShape = "plain" | "full" | "with-subscription";
export type ForumShape = "plain" | "with-family";

// Only `readable` carries the row, so a handler must narrow on `kind` before
// it can read the topic.
export type TopicLoad =
  | { kind: "readable"; topic: any }
  // A hidden topic the viewer may not read. Only the forum id comes back, so
  // GET /topics/:slug can send the viewer there with a notice.
  | { kind: "hidden"; forumId: number }
  // Missing, or denied for any other reason.
  | { kind: "absent" };

export type ForumLoad = { kind: "readable"; forum: any } | { kind: "absent" };

// Returns the presented topic only if the viewer passes READ_TOPIC on it.
// with-subscription needs a viewer: its columns are that viewer's.
export async function loadTopicFor(
  viewer: any,
  topicId: number,
  shape: TopicShape,
): Promise<TopicLoad> {
  assert(Number.isInteger(topicId), `topicId must be an integer: ${topicId}`);
  const topic = await queryTopic(viewer, topicId, shape);
  if (!topic) return { kind: "absent" };
  if (cancan.cannot(viewer, "READ_TOPIC", topic)) {
    return topic.is_hidden
      ? { kind: "hidden", forumId: topic.forum_id }
      : { kind: "absent" };
  }
  return { kind: "readable", topic: pre.presentTopic(topic) };
}

// Returns the presented forum only if the viewer passes READ_FORUM on it.
export async function loadForumFor(
  viewer: any,
  forumId: number,
  shape: ForumShape,
): Promise<ForumLoad> {
  assert(Number.isInteger(forumId), `forumId must be an integer: ${forumId}`);
  const forum =
    shape === "plain"
      ? await findForumById(forumId)
      : await findForumWithFamily(forumId);
  if (!forum || cancan.cannot(viewer, "READ_FORUM", forum)) {
    return { kind: "absent" };
  }
  return { kind: "readable", forum: pre.presentForum(forum) };
}

////////////////////////////////////////////////////////////

function queryTopic(viewer: any, topicId: number, shape: TopicShape) {
  switch (shape) {
    case "plain":
      return findTopic(topicId);
    case "full":
      return findTopicById(topicId);
    case "with-subscription":
      assert(viewer, "with-subscription needs a viewer");
      return findTopicWithIsSubscribed(viewer.id, topicId);
  }
}

// The forum's mods as {id, uname, slug} users. Selected with the row, so
// READ_TOPIC and the mod rules in server/cancan.ts see them before they run.
function forumModsColumn(forumId: "t.forum_id" | "f.id") {
  return `(
    SELECT COALESCE(
      json_agg(json_build_object('id', mu.id, 'uname', mu.uname, 'slug', mu.slug)),
      '[]'::json
    )
    FROM forum_mods fm
    JOIN users mu ON mu.id = fm.user_id
    WHERE fm.forum_id = ${forumId}
  ) "mods"`;
}

// The topic's banned user ids as a JSON array, empty when it has none. Every
// topic and post loader that feeds CREATE_POST or UPDATE_POST selects it,
// since server/cancan.ts#assertBansLoaded refuses a target without it. Expects
// the topic aliased as t. Exported for server/db/index.ts#findPostById only;
// server/db/index.ts does not re-export it.
export const BANNED_IDS_COLUMN = `COALESCE(
  (SELECT json_agg(tb.banned_id) FROM topic_bans tb WHERE tb.topic_id = t.id),
  '[]'::json
) banned_ids`;

function findTopic(topicId: number) {
  return pool
    .query(
      `
    SELECT
      t.*,
      to_json(f.*) "forum",
      ${forumModsColumn("t.forum_id")},
      ${BANNED_IDS_COLUMN}
    FROM topics t
    JOIN forums f ON t.forum_id = f.id
    WHERE t.id = $1
  `,
      [topicId],
    )
    .then(maybeOneRow);
}

// Keep in sync with findTopicWithIsSubscribed
function findTopicById(topicId: number) {
  debug(`[findTopicById] topicId=${topicId}`);

  return pool
    .query(
      `
SELECT
  t.*,
  to_json(f.*) "forum",
  ${forumModsColumn("t.forum_id")},
  (SELECT to_json(u2.*) FROM users u2 WHERE u2.id = t.user_id) "user",
  (SELECT json_agg(u3.uname) FROM users u3 WHERE u3.id = ANY (t.co_gm_ids::int[])) co_gm_unames,
  ${BANNED_IDS_COLUMN},
  (
   SELECT json_agg(tags.*)
   FROM tags
   JOIN tags_topics ON tags.id = tags_topics.tag_id
   WHERE tags_topics.topic_id = t.id
  ) tags
FROM topics t
JOIN forums f ON t.forum_id = f.id
WHERE t.id = $1
GROUP BY t.id, f.id
  `,
      [topicId],
    )
    .then(maybeOneRow);
}

// findTopicById plus the user's is_subscribed boolean and unread_* flags.
// Keep in sync with findTopicById
function findTopicWithIsSubscribed(userId: number, topicId: number) {
  debug("[findTopicWithIsSubscribed] userId %s, topicId %s:", userId, topicId);

  return pool
    .query(
      `
    SELECT
      (
        CASE
          WHEN t.ic_posts_count = 0 THEN false
          ELSE
            (
              SELECT COALESCE(
                (
                  SELECT t.latest_ic_post_id > w.watermark_post_id
                  FROM topics_users_watermark w
                  WHERE w.topic_id = t.id AND w.post_type = 'ic' AND w.user_id = $1
                ),
                true
              )
            )
        END
      ) unread_ic,
      (
        CASE
          WHEN t.ooc_posts_count = 0 THEN false
          ELSE
            (
              SELECT COALESCE(
                (
                  SELECT COALESCE(t.latest_ooc_post_id, t.latest_post_id) > w.watermark_post_id
                  FROM topics_users_watermark w
                  WHERE w.topic_id = t.id AND w.post_type = 'ooc' AND w.user_id = $1
                ),
                true
              )
            )
        END
      ) unread_ooc,
      (
        CASE
          WHEN t.char_posts_count = 0 THEN false
          ELSE
            (
              SELECT COALESCE(
                (
                  SELECT t.latest_char_post_id > w.watermark_post_id
                  FROM topics_users_watermark w
                  WHERE w.topic_id = t.id AND w.post_type = 'char' AND w.user_id = $1
                ),
                true
              )
            )
        END
      ) unread_char,
      t.*,
      to_json(f.*) "forum",
      ${forumModsColumn("t.forum_id")},
      array_agg($1::int) @> Array[ts.user_id::int] "is_subscribed",
      (SELECT to_json(u2.*) FROM users u2 WHERE u2.id = t.user_id) "user",
      (SELECT json_agg(u3.uname) FROM users u3 WHERE u3.id = ANY (t.co_gm_ids::int[])) co_gm_unames,
      ${BANNED_IDS_COLUMN},
      (
      SELECT json_agg(tags.*)
      FROM tags
      JOIN tags_topics ON tags.id = tags_topics.tag_id
      WHERE tags_topics.topic_id = t.id
      ) tags
    FROM topics t
    JOIN forums f ON t.forum_id = f.id
    LEFT OUTER JOIN topic_subscriptions ts ON t.id = ts.topic_id AND ts.user_id = $1
    WHERE t.id = $2
    GROUP BY t.id, f.id, ts.user_id
  `,
      [userId, topicId],
    )
    .then(maybeOneRow);
}

// @fast
function findForumById(forumId: number) {
  return pool
    .query(
      `
    SELECT
      f.*,
      ${forumModsColumn("f.id")},
      to_json(f2.*) "child_forum",
      to_json(f3.*) "parent_forum"
    FROM forums f
    LEFT OUTER JOIN forums f2 ON f.id = f2.parent_forum_id
    LEFT OUTER JOIN forums f3 ON f.parent_forum_id = f3.id
    WHERE f.id = $1
    GROUP BY f.id, f2.id, f3.id
  `,
      [forumId],
    )
    .then(maybeOneRow);
}

// - child_forums are a list of forums that point to this one
// - sibling_forums are all children at this level including curr forum
function findForumWithFamily(forumId: number) {
  return pool
    .query(
      `
    SELECT
      f.*,
      ${forumModsColumn("f.id")},
      (
        SELECT COALESCE(json_agg(forums.*), '[]')
        FROM forums
        WHERE parent_forum_id = $1
      ) "child_forums",
      (
        SELECT COALESCE(json_agg(forums.*), '[]')
        FROM forums
        WHERE parent_forum_id = f.parent_forum_id
           OR id = f.id
      ) "sibling_forums",
      (
        SELECT to_json(forums.*)
        FROM forums
        WHERE id = f.parent_forum_id
      ) "parent_forum"
    FROM forums f
    WHERE f.id = $2
    GROUP BY f.id
  `,
      [forumId, forumId],
    )
    .then(maybeOneRow);
}
