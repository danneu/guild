// 3rd
const assert = require('better-assert')
const { sql } = require('pg-extra')
const knex = require('knex')({ client: 'pg' })
// 1st
const { pool } = require('./util')

// WARNING: This is only stubbed out and quickly tested on
// localhost. Need to revisit it and finish it up before
// using it in production.
//
// Husk user is merged into main user
exports.mergeUsers = async ({ mainId, huskId }) => {
    return

    return pool.withTransaction(async client => {
        // Move topics
        await client.query(sql`
      UPDATE topics
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
    `)
        // Move posts
        await client.query(sql`
      UPDATE posts
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
    `)
        // Move post_revs
        await client.query(sql`
      UPDATE post_revs
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
    `)
        // Move topic_subscriptions
        // unique(user_id, topic_id)
        await client.query(sql`
      UPDATE topic_subscriptions
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
        AND topic_id NOT IN (
          SELECT topic_id FROM topic_subscriptions
          WHERE user_id = ${mainId}
        )
    `)
        // Move convos
        await client.query(sql`
      UPDATE convos
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
    `)
        // Move PMs
        await client.query(sql`
      UPDATE pms
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
    `)
        // Move convos_participants
        // unique(user_id, convo_id)
        await client.query(sql`
      UPDATE convos_participants
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
        AND convo_id NOT IN (
          SELECT convo_id FROM convos_participants
          WHERE user_id = ${mainId}
        )
    `)
        // Move albums
        await client.query(sql`
      UPDATE albums
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
    `)
        // Move images
        await client.query(sql`
      UPDATE images
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
    `)
        // Move topic_bans
        await client.query(sql`
      UPDATE topic_bans
      SET banned_by_id = ${mainId}
      WHERE banned_by_id = ${huskId}
    `)
        // Move forum mods
        // unique(forum_id, user_id)
        await client.query(sql`
      UPDATE forum_mods
      SET user_id = ${mainId}
      WHERE user_id = ${huskId}
        AND forum_id NOT IN (
          SELECT forum_id FROM forum_mods
          WHERE user_id = ${mainId}
        )
    `)

        // Do nothing with statuses
        // Do nothing with ratings
        // Do nothing with status_likes
        // Do nothing with friendships
        // Do nothing with arena_outcomes
        // Do nothing with VMs
        // Do nothing with hits
        // TODO: Trophies

        // Reset main's notifications

        // Recount main and husk:
        // - posts_count
        // - pms_count
        // - TODO: trophy_count (after moving trophies)
        await client.query(sql`
      UPDATE users
      SET posts_count = sub.posts_count
        , pms_count = sub.pms_count
      FROM (
        SELECT
          users.id,
          (SELECT COUNT(id) FROM posts WHERE user_id = users.id) posts_count,
          (SELECT COUNT(id) FROM pms WHERE user_id = users.id) pms_count
        FROM users
        WHERE id IN (${mainId}, ${huskId})
      ) sub
      WHERE users.id = sub.id
    `)
    })
}

////////////////////////////////////////////////////////////

// NOTE: This is dead code that was already here when I needed
// to commit another function into this file. It's some code
// I want to get working at some point rather than delete
// into the void.
//
// blurb is optional string
//
// Returns number of notifications created
exports.createGuildUpdateNotifications = async (postId, blurb) => {
    return

    assert(Number.isInteger(postId))
    assert(typeof blurb === 'string')

    const meta = { blurb }

    // get all userIds that we want to notify
    // - only members
    // - only people that logged in recently
    const userIds = await pool
        .many(
            sql`
    SELECT id
    FROM users
    WHERE role = 'member'
      AND last_online_at > NOW() - '3 months'::interval
  `
        )
        .then(xs => xs.map(x => x.id))

    console.log(`[guild-update] notifying ${userIds.length} users...`)

    const postIds = userIds.map(() => postId)
    const metas = userIds.map(() => meta)

    return pool
        .query(
            sql`
    INSERT INTO notifications (type, from_user_id, post_id, to_user_id, meta)
    SELECT
      'GUILD_UPDATE', 1, post_id, to_user_id, meta
    FROM unnest(
        ${postIds}::int[],
        ${userIds}::int[],
        ${metas}::json[]
    ) as sub (post_id, to_user_id, meta)
  `
        )
        .then(res => res.rowCount)
}
