'use strict'
// 3rd
const assert = require('better-assert')
const knex = require('knex')({ client: 'pg' });
const debug = require('debug')('app:db:hits')
// 1st
const {pool} = require('./util')
const {sql} = require('pg-extra')
const {isValidUuid} = require('../belt')

////////////////////////////////////////////////////////////

// hits is array of {user_id, ip_address, track}
exports.insertHits = async (hits) => {
  debug('[insertHits] hits: %j', hits)

  hits.forEach((hit) => {
    assert(Number.isInteger(hit.user_id))
    assert(typeof hit.ip_address === 'string')
    assert(isValidUuid(hit.track))
  })

  const string = knex('hits')
    .insert(hits)
    .toString()

  return pool._query(string)
}

////////////////////////////////////////////////////////////

// TODO: Search within last 30 days or so.
exports.findAltsFromRequest = async (ipAddress, track) => {
  debug(`[findAltsFromRequest] ipAddress=%j track=%j`, ipAddress, track)
  assert(typeof ipAddress === 'string')
  assert(isValidUuid(track))

  // NOTE: The CASE expressions try to match TRACK first since it's
  // the best alt-account indicator.

  const rows = await pool.many(sql`
    WITH RECURSIVE sub1 (user_id, ip_address, track, created_at, match) AS (
      SELECT
        user_id, ip_address, track, created_at,
        CASE
          WHEN hits.track = ${track} THEN 'TRACK'
          WHEN ip_root(hits.ip_address) = ip_root(${ipAddress}) THEN 'IP_ADDRESS'
        END as "match"
      FROM hits
      WHERE track = ${track}
         OR ip_root(ip_address) = ip_root(${ipAddress})

      UNION

      SELECT
        hits.user_id, hits.ip_address, hits.track, hits.created_at,
        CASE
          WHEN hits.track = sub1.track THEN 'TRACK'
          WHEN ip_root(hits.ip_address) = ip_root(sub1.ip_address) THEN 'IP_ADDRESS'
        END as "match"
      FROM sub1, hits
      WHERE hits.user_id != sub1.user_id
        AND (
          hits.track = sub1.track
          OR ip_root(hits.ip_address) = ip_root(sub1.ip_address)
        )
    )

    SELECT
      sub1.match,
      MAX(sub1.created_at) "latest_match_at",
      (SELECT to_json(users.*) FROM users WHERE id = sub1.user_id) "user"
    FROM sub1
    GROUP BY sub1.user_id, sub1.match
  `)

  // mapping of user_id -> {user: {...}, matches: {'TRACK': Date, 'IP_ADDRESS': Date, ...]}
  const map = {}

  rows.forEach((row) => {
    if (map[row.user.id]) {
      map[row.user.id].matches[row.match] = row.latest_match_at
    } else {
      map[row.user.id] = {
        matches: { [row.match]: row.latest_match_at },
        user: row.user
      }
    }
  })

  return Object.values(map)
}


// FIXME: I wrote findAltsFromRequest first and then realized I wanted
// a lookup that starts with a userId so I copy and pasted it into this
// function and quickly edited the query. It needs some work.
//
// Keep synced with findAltsFromRequest
//
// TODO: Search within last 30 days or so.
exports.findAltsFromUserId = async (userId) => {
  debug(`[findAltsFromUserId] userId=%j`, userId)
  assert(Number.isInteger(userId))

  // NOTE: The CASE expressions try to match TRACK first since it's
  // the best alt-account indicator.

  const rows = await pool.many(sql`
    WITH RECURSIVE sub1 (user_id, ip_address, track, created_at, match) AS (
      SELECT
        user_id, ip_address, track, created_at,
        CASE
          WHEN hits.track IN (SELECT DISTINCT track FROM hits WHERE user_id = ${userId}) THEN 'TRACK'
          WHEN ip_root(hits.ip_address) IN (SELECT DISTINCT ip_root(ip_address) FROM hits WHERE user_id = ${userId}) THEN 'IP_ADDRESS'
        END as "match"
      FROM hits
      WHERE track IN (SELECT DISTINCT track FROM hits WHERE user_id = ${userId})
         OR ip_root(ip_address) IN (SELECT DISTINCT ip_root(ip_address) FROM hits WHERE user_id = ${userId})

      UNION

      SELECT
        hits.user_id, hits.ip_address, hits.track, hits.created_at,
        CASE
          WHEN hits.track = sub1.track THEN 'TRACK'
          WHEN ip_root(hits.ip_address) = ip_root(sub1.ip_address) THEN 'IP_ADDRESS'
        END as "match"
      FROM sub1, hits
      WHERE hits.user_id != sub1.user_id
        AND (
          hits.track = sub1.track
          OR ip_root(hits.ip_address) = ip_root(sub1.ip_address)
        )
    )

    SELECT
      sub1.match,
      MAX(sub1.created_at) "latest_match_at",
      (SELECT to_json(users.*) FROM users WHERE id = sub1.user_id) "user"
    FROM sub1
    WHERE user_id != ${userId}
    GROUP BY sub1.user_id, sub1.match
  `)

  // mapping of user_id -> {user: {...}, matches: {'TRACK': Date, 'IP_ADDRESS': Date, ...]}
  const map = {}

  rows.forEach((row) => {
    if (map[row.user.id]) {
      map[row.user.id].matches[row.match] = row.latest_match_at
    } else {
      map[row.user.id] = {
        matches: { [row.match]: row.latest_match_at },
        user: row.user
      }
    }
  })

  return Object.values(map)
}
