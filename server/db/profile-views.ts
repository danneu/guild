'use strict'
// 3rd
const debug = require('debug')('app:db:profile-views')
const assert = require('assert')
// 1st
const { pool } = require('./util')
const { sql } = require('pg-extra')

////////////////////////////////////////////////////////////

exports.insertView = async function(viewerId, viewedId) {
    assert(Number.isInteger(viewerId))
    assert(Number.isInteger(viewedId))
    return pool.query(sql`
    INSERT INTO profile_views (viewer_id, viewed_id)
    VALUES (${viewerId}, ${viewedId})
  `)
}

exports.getLatestViews = async function(viewedId) {
    assert(Number.isInteger(viewedId))

    return pool.many(sql`
    SELECT viewers.uname
          , viewers.slug
          , viewers.avatar_url
          , MAX(pv.created_at) as "maxstamp"
    FROM profile_views pv
    JOIN users viewers ON pv.viewer_id = viewers.id
    WHERE pv.viewed_id = ${viewedId}
    GROUP BY viewers.uname, viewers.slug, viewers.avatar_url
    ORDER BY maxstamp DESC
    LIMIT 10
 `)
}
