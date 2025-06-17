"use strict";
// 3rd
import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db:unames");
// 1st
import { pool, maybeOneRow } from "./util";
import * as belt from "../belt";

////////////////////////////////////////////////////////////

export const lastUnameChange = async function (userId: number) {
  return pool
    .query(
      `
    SELECT *
    FROM unames
    WHERE user_id = $1
      AND recycle = false
    ORDER BY id DESC
    LIMIT 1
  `,
      [userId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Get all username changes for a given user. Will return at least one username (their initial username).
export const userUnameHistory = async function (userId: number) {
  assert(Number.isInteger(userId));
  return pool
    .query(
      `
    SELECT
      h.*,
      CASE WHEN u2 IS NULL THEN NULL
      ELSE
        json_build_object(
          'id', u2.id,
          'uname', u2.uname,
          'slug', u2.slug,
          'avatar_url', u2.avatar_url
        )
      END "changed_by"
    FROM unames h
    LEFT OUTER JOIN users u2 ON h.changed_by_id = u2.id
    WHERE h.user_id = $1
    ORDER BY h.id DESC
    `,
      [userId],
    )
    .then((res) => res.rows);
};

export const latestUnameChanges = async function (limit: number = 10) {
  return pool
    .query(
      `
    SELECT
      h.*,
      json_build_object(
        'id', u1.id,
        'uname', u1.uname,
        'slug', u1.slug,
        'avatar_url', u1.avatar_url
      ) "user",
      CASE WHEN u2 IS NULL THEN NULL
      ELSE
        json_build_object(
          'id', u2.id,
          'uname', u2.uname,
          'slug', u2.slug,
          'avatar_url', u2.avatar_url
        )
      END "changed_by",
      (
        SELECT json_build_object(
          'uname', unames.uname,
          'recycle', unames.recycle
        )
        FROM unames
        WHERE user_id = h.user_id
          AND id < h.id
        ORDER BY id DESC
        LIMIT 1
      ) "prev_uname"
    FROM unames h
    JOIN users u1 ON h.user_id = u1.id
    LEFT OUTER JOIN users u2 ON h.changed_by_id = u2.id
    WHERE changed_by_id IS NOT NULL
    ORDER BY h.id DESC
    LIMIT $1
  `,
      [limit],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export async function changeUname({
  userId,
  changedById,
  oldUname,
  newUname,
  recycle = false,
}: {
  userId: number;
  changedById: number;
  oldUname: string;
  newUname: string;
  recycle?: boolean;
}) {
  debug(`[changeUname] oldUname=%j, newUname=%j`, oldUname, newUname);
  assert(Number.isInteger(userId));
  assert(Number.isInteger(changedById));
  assert(typeof oldUname === "string");
  assert(typeof newUname === "string");
  assert(oldUname !== newUname);
  assert(typeof recycle === "boolean");

  return pool.withTransaction(async (client) => {
    await client
      .query(
        `
      INSERT INTO unames (user_id, changed_by_id, uname, slug)
      VALUES (
        $1,
        $2,
        $3,
        $4
      )
    `,
        [userId, changedById, newUname, belt.slugifyUname(newUname)],
      )
      .catch((err) => {
        if (err instanceof Error && "code" in err && err.code === "23505") {
          if (/unique_unrecyclable_slug/.test(err.toString()))
            throw "UNAME_TAKEN";
        }
        throw err;
      });

    // Update previous uname change
    if (recycle) {
      await client.query(
        `
        UPDATE unames
        SET recycle = true
        WHERE user_id = $1
          AND slug = $2
      `,
        [userId, belt.slugifyUname(oldUname)],
      );
    }

    return client
      .query(
        `
      UPDATE users
      SET uname = $1,
          slug = $2
      WHERE id = $3
      RETURNING *
    `,
        [newUname, belt.slugifyUname(newUname), userId],
      )
      .then(maybeOneRow);
  });
}

////////////////////////////////////////////////////////////
