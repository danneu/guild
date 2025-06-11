'use strict'
// 3rd
const { assert } = require('../util')
const { sql } = require('pg-extra')
const debug = require('debug')('app:db:unames')
// 1st
const { pool } = require('./util')
const belt = require('../belt')

////////////////////////////////////////////////////////////

exports.lastUnameChange = async function(userId) {
    return pool.one(sql`
    SELECT *
    FROM unames
    WHERE user_id = ${userId}
      AND recycle = false
    ORDER BY id DESC
    LIMIT 1
  `)
}

////////////////////////////////////////////////////////////

// Get all username changes for a given user. Will return at least one username (their initial username).
exports.userUnameHistory = async function(userId) {
    assert(Number.isInteger(userId))
    return pool.many(sql`
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
    WHERE h.user_id = ${userId}
    ORDER BY h.id DESC
    `)
}

exports.latestUnameChanges = async function(limit = 10) {
    return pool.many(sql`
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
    LIMIT ${limit}
  `)
}

////////////////////////////////////////////////////////////

exports.changeUname = async function({
    userId,
    changedById,
    oldUname,
    newUname,
    recycle = false,
}) {
    debug(`[changeUname] oldUname=%j, newUname=%j`, oldUname, newUname)
    assert(Number.isInteger(userId))
    assert(Number.isInteger(changedById))
    assert(typeof oldUname === 'string')
    assert(typeof newUname === 'string')
    assert(oldUname !== newUname)
    assert(typeof recycle === 'boolean')

    return pool.withTransaction(async client => {
        await client
            .query(
                sql`
      INSERT INTO unames (user_id, changed_by_id, uname, slug)
      VALUES (
        ${userId},
        ${changedById},
        ${newUname},
        ${belt.slugifyUname(newUname)}
      )
    `
            )
            .catch(err => {
                if (err.code === '23505') {
                    if (/unique_unrecyclable_slug/.test(err.toString()))
                        throw 'UNAME_TAKEN'
                }
                throw err
            })

        // Update previous uname change
        if (recycle) {
            await client.query(sql`
        UPDATE unames
        SET recycle = true
        WHERE user_id = ${userId}
          AND slug = ${belt.slugifyUname(oldUname)}
      `)
        }

        return client.one(sql`
      UPDATE users
      SET uname = ${newUname},
          slug = ${belt.slugifyUname(newUname)}
      WHERE id = ${userId}
      RETURNING *
    `)
    })
}

////////////////////////////////////////////////////////////
