"use strict";
// 3rd
import assert from "assert";
import Knex from "knex";
const knex = Knex({ client: "pg" });
import createDebug from "debug";
const debug = createDebug("app:db:hits");
// 1st
import { pool } from "./util";
import { isValidUuid } from "../belt";

////////////////////////////////////////////////////////////

// hits is array of {user_id, ip_address, track}
export const insertHits = async (hits: Array<{ user_id: number; ip_address: string; track: string }>) => {
  debug("[insertHits] hits: %j", hits);

  hits.forEach((hit) => {
    assert(Number.isInteger(hit.user_id));
    assert(typeof hit.ip_address === "string");
    assert(isValidUuid(hit.track));
  });

  const string = knex("hits").insert(hits).toString();

  return pool.query(string);
};

////////////////////////////////////////////////////////////

// TODO: Search within last 30 days or so.
export const findAltsFromRequest = async (ipAddress: string, track: string) => {
  debug(`[findAltsFromRequest] ipAddress=%j track=%j`, ipAddress, track);
  assert(typeof ipAddress === "string");
  assert(isValidUuid(track));

  // NOTE: The CASE expressions try to match TRACK first since it's
  // the best alt-account indicator.

  const rows = await pool
    .query(
      `
    WITH RECURSIVE sub1 (user_id, ip_address, track, created_at, match) AS (
      SELECT
        user_id, ip_address, track, created_at,
        CASE
          WHEN hits.track = $1 THEN 'TRACK'
          WHEN ip_root(hits.ip_address) = ip_root($2) THEN 'IP_ADDRESS'
        END as "match"
      FROM hits
      WHERE track = $1
         OR ip_root(ip_address) = ip_root($2)

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
  `,
      [track, ipAddress],
    )
    .then((res) => res.rows);

  // mapping of user_id -> {user: {...}, matches: {'TRACK': Date, 'IP_ADDRESS': Date, ...]}
  const map = {};

  rows.forEach((row) => {
    if (map[row.user.id]) {
      map[row.user.id].matches[row.match] = row.latest_match_at;
    } else {
      map[row.user.id] = {
        matches: { [row.match]: row.latest_match_at },
        user: row.user,
      };
    }
  });

  return Object.values(map);
};

// FIXME: I wrote findAltsFromRequest first and then realized I wanted
// a lookup that starts with a userId so I copy and pasted it into this
// function and quickly edited the query. It needs some work.
//
// Keep synced with findAltsFromRequest
//
// TODO: Search within last 30 days or so.
//
// http://sqlfiddle.com/#!17/e3e74/1/0
export const findAltsFromUserId = async (userId: number) => {
  debug(`[findAltsFromUserId] userId=%j`, userId);
  assert(Number.isInteger(userId));

  // NOTE: The CASE expressions try to match TRACK first since it's
  // the best alt-account indicator.

  const rows = await pool
    .query(
      `
    WITH RECURSIVE tracks AS (
      -- Get all tracks for the init case
      SELECT DISTINCT track FROM hits WHERE user_id = $1
    ), ip_roots AS (
      -- Get all ip addresses for the init case
      SELECT DISTINCT ip_root(ip_address) ip_address_root
      FROM hits WHERE user_id = $1
    ), sub1 (user_id, ip_address, track, created_at, match) AS (
      -- Init case
      SELECT
        user_id, ip_address, track, created_at,
        CASE
          WHEN hits.track IN (SELECT track FROM tracks)
            THEN 'TRACK'
          WHEN ip_root(hits.ip_address) IN (SELECT ip_address_root FROM ip_roots)
            THEN 'IP_ADDRESS'
        END as "match"
      FROM hits
      WHERE track IN (SELECT track FROM tracks)
        OR ip_root(ip_address) IN (SELECT ip_address_root FROM ip_roots)

      UNION

      -- Recursive case
      SELECT
        hits.user_id, hits.ip_address, hits.track, hits.created_at,
        --CASE
        --  -- If the previous match was IP_ADDRESS, then this one should be
        --  -- too since IP_ADDRESS weakens all downstream matches.
        --  -- E.g. A link of userA -ip-> ... -track-> userB should not be
        --  --      a TRACK match.
        --  WHEN sub1.match = 'IP_ADDRESS' THEN 'IP_ADDRESS'
        --  WHEN hits.track = sub1.track THEN 'TRACK'
        --  WHEN ip_root(hits.ip_address) = ip_root(sub1.ip_address) THEN 'IP_ADDRESS'
        --END as "match"
        'IP_ADDRESS' "match"
      FROM sub1, hits
      WHERE hits.user_id != sub1.user_id
        AND (
          hits.track = sub1.track
          OR ip_root(hits.ip_address) = ip_root(sub1.ip_address)
        )
        -- Exclude hits found in the init case
        AND hits.track NOT IN (SELECT track from tracks)
        AND hits.ip_address NOT IN (SELECT ip_address_root from ip_roots)
    )

    SELECT
      sub1.match,
      MAX(sub1.created_at) latest_match_at,
      (
        SELECT json_build_object(
          'uname', users.uname,
          'slug', users.slug,
          'role', users.role,
          'is_nuked', users.is_nuked,
          'created_at', users.created_at
        )
        FROM users
        WHERE id = sub1.user_id
      ) "user"
    FROM sub1
    WHERE user_id != $1
    GROUP BY sub1.user_id, sub1.match
    ORDER BY sub1.user_id DESC
  `,
      [userId],
    )
    .then((res) => res.rows);

  // mapping of user_id -> {user: {...}, matches: {'TRACK': Date, 'IP_ADDRESS': Date, ...]}
  const map: Record<string, { matches: Record<string, Date>; user: any }> =
    Object.create(null);

  rows.forEach((row) => {
    if (map[row.user.uname]) {
      map[row.user.uname]!.matches[row.match] = row.latest_match_at;
    } else {
      map[row.user.uname] = {
        matches: { [row.match]: row.latest_match_at },
        user: row.user,
      };
    }
  });

  return Object.values(map);
};
