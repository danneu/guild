// 3rd
import assert from 'assert'
// 1st
import { pool  } from './util'
import { sql } from 'pg-extra'
import pg from 'pg'

////////////////////////////////////////////////////////////

// Reason is optional
export async function insertPostRev(client: pg.PoolClient, userId: number, postId: number, markup: string, html: string, reason?: string) {
        assert(Number.isInteger(userId))
        assert(Number.isInteger(postId))
        assert(typeof markup === 'string')
        assert(typeof html === 'string')
        assert(!reason || typeof reason === 'string')

        return client.query(sql`
    INSERT INTO post_revs (user_id, post_id, markup, html, length, reason)
    VALUES (
      ${userId},
      ${postId},
      ${markup},
      ${html},
      ${Buffer.byteLength(markup)},
      ${reason}
    )
  `)
    }

export async function revertPostRev(userId: number, postId: number, revId: number) {
    assert(Number.isInteger(userId))
    assert(Number.isInteger(postId))
    assert(Number.isInteger(revId))

    const reason = `Reverted to revision ${revId}`

    return pool.query(sql`
    WITH rev AS (
      INSERT INTO post_revs (user_id, post_id, markup, html, length, reason)
      SELECT
        ${userId},
        ${postId},
        markup,
        html,
        length,
        ${reason}
      FROM post_revs
      WHERE id = ${revId}
      RETURNING html, markup
    )
    UPDATE posts
    SET markup = rev.markup
      , html = rev.html
      , updated_at = NOW()
    FROM rev
    WHERE posts.id = ${postId}
  `)
}

////////////////////////////////////////////////////////////

export async function getPostRevMarkup(postId: number, revId: number) {
    assert(Number.isInteger(postId))
    assert(Number.isInteger(revId))

    return pool
        .one(
            sql`
    SELECT markup
    FROM post_revs
    WHERE post_id = ${postId}
      AND id = ${revId}
  `
        )
        .then(row => {
            return row && row.markup
        })
}

export async function getPostRev(postId: number, revId: number) {
    assert(Number.isInteger(postId))
    assert(Number.isInteger(revId))

    return pool.one(sql`
    SELECT
      post_revs.id,
      post_revs.post_id,
      post_revs.user_id,
      post_revs.html,
      post_revs.created_at,
      json_build_object(
        'uname', u.uname,
        'slug', u.slug
      ) "user"
    FROM post_revs
    JOIN users u ON u.id = post_revs.user_id
    WHERE post_revs.post_id = ${postId}
      AND post_revs.id = ${revId}
  `)
}

////////////////////////////////////////////////////////////

export async function listPostRevs(postId: number) {
    assert(Number.isInteger(postId))

    return pool.many(sql`
    SELECT
      post_revs.id,
      post_revs.post_id,
      post_revs.user_id,
      post_revs.length,
      post_revs.reason,
      post_revs.created_at,
      json_build_object(
        'uname', u.uname,
        'slug', u.slug
      ) "user"
    FROM post_revs
    JOIN users u ON u.id = post_revs.user_id
    WHERE post_revs.post_id = ${postId}
    ORDER BY post_revs.id DESC
    LIMIT 25
  `)
}

////////////////////////////////////////////////////////////
