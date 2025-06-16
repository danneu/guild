// 3rd
import assert from "assert";
// 1st
import { pool, maybeOneRow } from "./util";
import pg from "pg";

////////////////////////////////////////////////////////////

// Reason is optional
export async function insertPostRev(
  client: pg.PoolClient,
  userId: number,
  postId: number,
  markup: string,
  html: string,
  reason?: string,
) {
  assert(Number.isInteger(userId));
  assert(Number.isInteger(postId));
  assert(typeof markup === "string");
  assert(typeof html === "string");
  assert(!reason || typeof reason === "string");

  return client.query(
    `
    INSERT INTO post_revs (user_id, post_id, markup, html, length, reason)
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6
    )
  `,
    [userId, postId, markup, html, Buffer.byteLength(markup), reason],
  );
}

export async function revertPostRev(
  userId: number,
  postId: number,
  revId: number,
) {
  assert(Number.isInteger(userId));
  assert(Number.isInteger(postId));
  assert(Number.isInteger(revId));

  const reason = `Reverted to revision ${revId}`;

  return pool.query(
    `
    WITH rev AS (
      INSERT INTO post_revs (user_id, post_id, markup, html, length, reason)
      SELECT
        $1,
        $2,
        markup,
        html,
        length,
        $3
      FROM post_revs
      WHERE id = $4
      RETURNING html, markup
    )
    UPDATE posts
    SET markup = rev.markup
      , html = rev.html
      , updated_at = NOW()
    FROM rev
    WHERE posts.id = $2
  `,
    [userId, postId, reason, revId],
  );
}

////////////////////////////////////////////////////////////

export async function getPostRevMarkup(postId: number, revId: number) {
  assert(Number.isInteger(postId));
  assert(Number.isInteger(revId));

  return pool
    .query(
      `
    SELECT markup
    FROM post_revs
    WHERE post_id = $1
      AND id = $2
  `,
      [postId, revId],
    )
    .then(maybeOneRow)
    .then((row) => {
      return row && row.markup;
    });
}

export async function getPostRev(postId: number, revId: number) {
  assert(Number.isInteger(postId));
  assert(Number.isInteger(revId));

  return pool
    .query(
      `
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
    WHERE post_revs.post_id = $1
      AND post_revs.id = $2
  `,
      [postId, revId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function listPostRevs(postId: number) {
  assert(Number.isInteger(postId));

  return pool
    .query(
      `
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
    WHERE post_revs.post_id = $1
    ORDER BY post_revs.id DESC
    LIMIT 25
  `,
      [postId],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////
