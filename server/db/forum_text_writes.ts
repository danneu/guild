// The raw writes of post text and topic titles: inserting a post or a topic,
// setting a post's markup and html, and setting a topic's title. Only
// server/forum_text.ts imports this module (server/parser-owners.test.ts), and
// server/write_census.test.ts fails on any other code that inserts a post or
// a topic or sets those columns. server/db/index.ts does not re-export it.
//
// Each write reads its actor once through lockStanding and applies the gates
// in its own transaction, before it writes: the post gap on a new post or
// topic (server/db/post_gap.ts), and the screening charge on every write
// (server/db/screen_budget.ts). It returns the charge with its row, for the
// owner to hand to the classifier after the commit. It takes html the owner
// already rendered, so no render holds the sender lock.

import assert from "assert";
import _ from "lodash";
import createDebug from "debug";
// 1st
import * as revs from "./revs";
import { admitPost } from "./post_gap";
import { lockStanding } from "./send_budget";
import { spendScreening, type ScreeningCharge } from "./screen_budget";
import {
  pool,
  maybeOneRow,
  exactlyOneRow,
  type PgClientInTransaction,
} from "./util";

const debug = createDebug("app:db:forum_text_writes");

// Args:
// - userId      Required Number/String
// - ipAddress   Optional String
// - markup      Required String
// - topicId     Required Number/String
// - type        Required String, ic | ooc | char
// - isRoleplay  Required Boolean
// - idx         Undefined or -1 if it's the tab's wiki post
//
// The author must have left the post gap since their last post
// (server/db/post_gap.ts), and pays the screening charge for the markup
// (server/db/screen_budget.ts), which comes back with the post.
export async function createPost(
  pgClient: PgClientInTransaction,
  args,
): Promise<{ post: any; charge: ScreeningCharge | null }> {
  debug(`[createPost] args:`, args);
  assert(_.isNumber(args.userId));
  assert(_.isString(args.ipAddress));
  assert(_.isString(args.markup));
  assert(_.isString(args.html));
  assert(args.topicId);
  assert(_.isBoolean(args.isRoleplay));
  assert(["ic", "ooc", "char"].includes(args.type));
  assert(args.idx === -1 || typeof args.idx === "undefined");

  const standing = await lockStanding(pgClient, args.userId);
  // A tab's 0th post skips the gap: posts_topic_id_type_idx_idx caps it at one
  // per tab, it needs UPDATE_TOPIC, and a GM setting up a new roleplay's tabs
  // should not wait between them.
  if (args.idx !== -1) {
    await admitPost(pgClient, standing, args.ipAddress);
  }
  const charge = await spendScreening(pgClient, standing, {
    title: null,
    body: args.markup,
  });

  const post = await pgClient
    .query(
      `
      INSERT INTO posts
        (user_id, ip_address, topic_id, markup, html, type, is_roleplay, idx)
      VALUES (
        $1, $2::inet,
        $3, $4,
        $5, $6, $7,
        $8
      )
      RETURNING *
    `,
      [
        args.userId,
        args.ipAddress,
        args.topicId,
        args.markup,
        args.html,
        args.type,
        args.isRoleplay,
        args.idx,
      ],
    )
    .then(maybeOneRow);

  await revs.insertPostRev(
    pgClient,
    args.userId,
    post.id,
    args.markup,
    args.html,
  );

  return { post, charge };
}

////////////////////////////////////////////////////////////

// Args:
// - userId     Required Number/String
// - forumId    Required Number/String
// - ipAddress  Optional String
// - title      Required String
// - markup     Required String
// - postType   Required String, ic | ooc | char
// - isRoleplay Required Boolean
// - tagIds     Optional [Int]
// - joinStatus Optional String (Required if roleplay)
//
// The author must have left the post gap since their last post
// (server/db/post_gap.ts), and pays the screening charge for the title and
// markup (server/db/screen_budget.ts), which comes back with the topic.
export async function createTopic(
  props,
): Promise<{ topic: any; charge: ScreeningCharge | null }> {
  debug("[createTopic]", props);
  assert(_.isNumber(props.userId));
  assert(props.forumId);
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.title));
  assert(_.isString(props.markup));
  assert(_.isString(props.html));
  assert(_.isBoolean(props.isRoleplay));
  assert(["ic", "ooc", "char"].includes(props.postType));
  assert(_.isArray(props.tagIds) || _.isUndefined(props.tagIds));
  // Only roleplays have join-status
  if (props.isRoleplay) assert(_.isString(props.joinStatus));
  else assert(_.isUndefined(props.joinStatus));

  return pool.withTransaction(async (client) => {
    const standing = await lockStanding(client, props.userId);
    await admitPost(client, standing, props.ipAddress);
    const charge = await spendScreening(client, standing, {
      title: props.title,
      body: props.markup,
    });

    // Create topic
    const topic = await client
      .query(
        `
      INSERT INTO topics
        (forum_id, user_id, title, is_roleplay, join_status)
      VALUES ($1, $2, $3,
        $4, $5)
      RETURNING *
    `,
        [
          props.forumId,
          props.userId,
          props.title,
          props.isRoleplay,
          props.joinStatus,
        ],
      )
      .then(maybeOneRow);

    // Create topic's first post
    const post = await client
      .query(
        `
      INSERT INTO posts
        (topic_id, user_id, ip_address, markup, html, type, is_roleplay, idx)
      VALUES ($1, $2, $3::inet,
       $4, $5, $6, $7, 0)
      RETURNING *
    `,
        [
          topic.id,
          props.userId,
          props.ipAddress,
          props.markup,
          props.html,
          props.postType,
          props.isRoleplay,
        ],
      )
      .then(maybeOneRow);

    // Create post revision
    await revs.insertPostRev(
      client,
      props.userId,
      post.id,
      props.markup,
      props.html,
    );

    // The owner screens the opening post's id
    topic.post = post;

    // Create tags if given
    if (props.tagIds) {
      const tasks = props.tagIds.map((tagId) =>
        client.query(
          `
        INSERT INTO tags_topics (topic_id, tag_id)
        VALUES ($1, $2)
      `,
          [topic.id, tagId],
        ),
      );
      await Promise.all(tasks);
    }

    return { topic, charge };
  });
}

////////////////////////////////////////////////////////////

// Keep updatePost and server/db/index.ts#updatePm in sync
//
// Updating a post saves the update as a revision. The editor pays the
// screening charge for the new markup (server/db/screen_budget.ts), which
// comes back with the post.
export async function updatePost(
  userId: number,
  postId: number,
  markup: string,
  html: string,
  reason: string | undefined,
): Promise<{ post: any; charge: ScreeningCharge | null }> {
  assert(Number.isInteger(userId));
  assert(Number.isInteger(postId));
  assert(typeof markup === "string");
  assert(typeof html === "string");
  assert(!reason || typeof reason === "string");

  return pool.withTransaction(async (client) => {
    const standing = await lockStanding(client, userId);
    const charge = await spendScreening(client, standing, {
      title: null,
      body: markup,
    });

    const post = await client
      .query(
        `
      WITH rev AS (
        INSERT INTO post_revs (user_id, post_id, markup, html, length, reason)
        VALUES (
          $1, $2, $3, $4, $5, $6
        )
        RETURNING html, markup
      )
      UPDATE posts
      SET markup = rev.markup
        , html = rev.html
        , updated_at = NOW()
      FROM rev
      WHERE posts.id = $7
      RETURNING *
    `,
        [
          userId,
          postId,
          markup,
          html,
          Buffer.byteLength(markup),
          reason,
          postId,
        ],
      )
      .then(maybeOneRow);

    return { post, charge };
  });
}

////////////////////////////////////////////////////////////

// Sets a topic's title. A new title pays the screening charge for what the
// classifier sends: the title with the topic's opening post. The actor pays,
// and the charge comes back with the opening post's id, which the moderators'
// notes link. An unchanged title pays nothing.
export async function updateTopicTitle(
  actorId: number,
  topicId: number,
  title: string,
): Promise<{ charge: ScreeningCharge | null; openingPostId: number }> {
  assert(Number.isInteger(actorId));
  assert(Number.isInteger(topicId));
  assert(typeof title === "string");

  return pool.withTransaction(async (client) => {
    const standing = await lockStanding(client, actorId);
    // The opening post has its topic's lowest post id.
    const current = await client
      .query<{
        title: string;
        opening_post_id: number;
        opening_markup: string;
      }>(
        `
      SELECT
        t.title,
        p.id AS opening_post_id,
        p.markup AS opening_markup
      FROM topics t
      JOIN LATERAL (
        SELECT id, markup
        FROM posts
        WHERE topic_id = t.id
        ORDER BY id
        LIMIT 1
      ) p ON true
      WHERE t.id = $1
    `,
        [topicId],
      )
      .then(exactlyOneRow);
    if (current.title === title) {
      return { charge: null, openingPostId: current.opening_post_id };
    }

    const charge = await spendScreening(client, standing, {
      title,
      body: current.opening_markup,
    });

    await client.query(
      `
      UPDATE topics
      SET title = $1
      WHERE id = $2
    `,
      [title, topicId],
    );

    return { charge, openingPostId: current.opening_post_id };
  });
}

////////////////////////////////////////////////////////////

// Hides a post while it still holds `markup`, the text a NUKE verdict judged.
// Returns whether it hid the post. A post edited since then holds other text
// and stays up. Hiding fires the post_hidden trigger, as any hide does.
export async function hidePostIfMarkup(
  postId: number,
  markup: string,
): Promise<boolean> {
  assert(Number.isInteger(postId));
  assert(typeof markup === "string");

  const result = await pool.query(
    `
    UPDATE posts
    SET is_hidden = true
    WHERE id = $1
      AND markup = $2
  `,
    [postId, markup],
  );
  return (result.rowCount ?? 0) > 0;
}

// Hides a topic while it still holds `title`, the title a NUKE verdict
// judged. Returns whether it hid the topic. A topic retitled since then stays
// up.
export async function hideTopicIfTitle(
  topicId: number,
  title: string,
): Promise<boolean> {
  assert(Number.isInteger(topicId));
  assert(typeof title === "string");

  const result = await pool.query(
    `
    UPDATE topics
    SET is_hidden = true
    WHERE id = $1
      AND title = $2
  `,
    [topicId, title],
  );
  return (result.rowCount ?? 0) > 0;
}
