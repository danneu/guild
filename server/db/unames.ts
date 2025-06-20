"use strict";
// 3rd
import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db:unames");
// 1st
import { pool, maybeOneRow } from "./util";
import * as belt from "../belt";
import { User } from "discord.js";
import { DbUser } from "../dbtypes";

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
}): Promise<
  | { type: "RATE_LIMITED" }
  | { type: "UNAME_TAKEN"; user: DbUser }
  | { type: "SUCCESS"; user: DbUser }
> {
  debug(`[changeUname] oldUname=%j, newUname=%j`, oldUname, newUname);
  assert(Number.isInteger(userId));
  assert(Number.isInteger(changedById));
  assert(typeof oldUname === "string");
  assert(typeof newUname === "string");
  assert(oldUname !== newUname);
  assert(typeof recycle === "boolean");

  return pool.withTransaction(async (client) => {
    const newSlug = belt.slugifyUname(newUname);
    const oldSlug = belt.slugifyUname(oldUname);

    // TODO: Let staff bypass this rate limit

    // Check if user changed username within the last month
    const lastChange = await client
      .query(
        `
        SELECT updated_at
        FROM unames
        WHERE user_id = $1
          AND changed_by_id IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [userId],
      )
      .then(maybeOneRow);

    if (lastChange) {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      if (lastChange.updated_at > threeMonthsAgo) {
        return { type: "RATE_LIMITED" };
      }
    }

    // Check if someone else has this username and it's not recyclable
    const takenByOther = await client
      .query(
        `
        SELECT 1
        FROM unames
        WHERE slug = $1 
          AND user_id != $2
          AND recycle = false
        LIMIT 1
        `,
        [newSlug, userId],
      )
      .then(maybeOneRow);

    if (takenByOther) {
      return { type: "UNAME_TAKEN", user: takenByOther };
    }

    // Check if we already have this username in our history
    const ownPreviousEntry = await client
      .query(
        `
        SELECT id
        FROM unames
        WHERE slug = $1 AND user_id = $2
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [newSlug, userId],
      )
      .then(maybeOneRow);

    if (ownPreviousEntry) {
      // We're reclaiming our own username - just update the existing entry
      await client.query(
        `
        UPDATE unames
        SET recycle = false,
            changed_by_id = $2,
            updated_at = NOW()
        WHERE id = $1
        `,
        [ownPreviousEntry.id, changedById],
      );
    } else {
      // This is a new username for us - insert a new record
      await client.query(
        `
        INSERT INTO unames (user_id, changed_by_id, uname, slug)
        VALUES ($1, $2, $3, $4)
        `,
        [userId, changedById, newUname, newSlug],
      );
    }

    // Mark the old username as recycled if requested
    if (recycle) {
      await client.query(
        `
        UPDATE unames
        SET recycle = true,
            updated_at = NOW()
        WHERE user_id = $1
          AND slug = $2
          AND recycle = false
        `,
        [userId, oldSlug],
      );
    }

    // Update the user record
    const user = await client
      .query(
        `
        UPDATE users
        SET uname = $1,
            slug = $2
        WHERE id = $3
        RETURNING *
        `,
        [newUname, newSlug, userId],
      )
      .then(maybeOneRow);

    return { type: "SUCCESS", user };
  });
}

////////////////////////////////////////////////////////////
