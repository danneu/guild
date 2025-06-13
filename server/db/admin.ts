// 3rd
import assert from "assert";
// import Knex from 'knex'
// const knex = Knex({ client: 'pg' })
// 1st
import { pool } from "./util";

// WARNING: This is only stubbed out and quickly tested on
// localhost. Need to revisit it and finish it up before
// using it in production.
//
// Husk user is merged into main user
export const mergeUsers = async ({ mainId, huskId }) => {
  return;

  return pool.withTransaction(async (client) => {
    // Move topics
    await client.query(
      `
      UPDATE topics
      SET user_id = $1
      WHERE user_id = $2
    `,
      [mainId, huskId],
    );
    // Move posts
    await client.query(
      `
      UPDATE posts
      SET user_id = $1
      WHERE user_id = $2
    `,
      [mainId, huskId],
    );
    // Move post_revs
    await client.query(
      `
      UPDATE post_revs
      SET user_id = $1
      WHERE user_id = $2
    `,
      [mainId, huskId],
    );
    // Move topic_subscriptions
    // unique(user_id, topic_id)
    await client.query(
      `
      UPDATE topic_subscriptions
      SET user_id = $1
      WHERE user_id = $2
        AND topic_id NOT IN (
          SELECT topic_id FROM topic_subscriptions
          WHERE user_id = $1
        )
    `,
      [mainId, huskId],
    );
    // Move convos
    await client.query(
      `
      UPDATE convos
      SET user_id = $1
      WHERE user_id = $2
    `,
      [mainId, huskId],
    );
    // Move PMs
    await client.query(
      `
      UPDATE pms
      SET user_id = $1
      WHERE user_id = $2
    `,
      [mainId, huskId],
    );
    // Move convos_participants
    // unique(user_id, convo_id)
    await client.query(
      `
      UPDATE convos_participants
      SET user_id = $1
      WHERE user_id = $2
        AND convo_id NOT IN (
          SELECT convo_id FROM convos_participants
          WHERE user_id = $1
        )
    `,
      [mainId, huskId],
    );
    // Move albums
    await client.query(
      `
      UPDATE albums
      SET user_id = $1
      WHERE user_id = $2
    `,
      [mainId, huskId],
    );
    // Move images
    await client.query(
      `
      UPDATE images
      SET user_id = $1
      WHERE user_id = $2
    `,
      [mainId, huskId],
    );
    // Move topic_bans
    await client.query(
      `
      UPDATE topic_bans
      SET banned_by_id = $1
      WHERE banned_by_id = $2
    `,
      [mainId, huskId],
    );
    // Move forum mods
    // unique(forum_id, user_id)
    await client.query(
      `
      UPDATE forum_mods
      SET user_id = $1
      WHERE user_id = $2
        AND forum_id NOT IN (
          SELECT forum_id FROM forum_mods
          WHERE user_id = $1
        )
    `,
      [mainId, huskId],
    );

    // Do nothing with statuses
    // Do nothing with ratings
    // Do nothing with status_likes
    // Do nothing with friendships
    // Do nothing with VMs
    // Do nothing with hits
    // TODO: Trophies

    // Reset main's notifications

    // Recount main and husk:
    // - posts_count
    // - pms_count
    // - TODO: trophy_count (after moving trophies)
    await client.query(
      `
      UPDATE users
      SET posts_count = sub.posts_count
        , pms_count = sub.pms_count
      FROM (
        SELECT
          users.id,
          (SELECT COUNT(id) FROM posts WHERE user_id = users.id) posts_count,
          (SELECT COUNT(id) FROM pms WHERE user_id = users.id) pms_count
        FROM users
        WHERE id IN ($1, $2)
      ) sub
      WHERE users.id = sub.id
    `,
      [mainId, huskId],
    );
  });
};

////////////////////////////////////////////////////////////

// NOTE: This is dead code that was already here when I needed
// to commit another function into this file. It's some code
// I want to get working at some point rather than delete
// into the void.
//
// blurb is optional string
//
// Returns number of notifications created
export const createGuildUpdateNotifications = async (postId, blurb) => {
  return;

  assert(Number.isInteger(postId));
  assert(typeof blurb === "string");

  const meta = { blurb };

  // get all userIds that we want to notify
  // - only members
  // - only people that logged in recently
  const userIds = await pool
    .query(
      `
    SELECT id
    FROM users
    WHERE role = 'member'
      AND last_online_at > NOW() - '3 months'::interval
  `,
    )
    .then((res) => res.rows)
    .then((xs) => xs.map((x) => x.id));

  console.log(`[guild-update] notifying ${userIds.length} users...`);

  const postIds = userIds.map(() => postId);
  const metas = userIds.map(() => meta);

  return pool
    .query(
      `
    INSERT INTO notifications (type, from_user_id, post_id, to_user_id, meta)
    SELECT
      'GUILD_UPDATE', 1, post_id, to_user_id, meta
    FROM unnest(
        $1::int[],
        $2::int[],
        $3::json[]
    ) as sub (post_id, to_user_id, meta)
  `,
      [postIds, userIds, metas],
    )
    .then((res) => res.rowCount);
};
