// 3rd
// import createDebug from 'debug'
// const debug = createDebug('app:db:profile-views')
import assert from 'assert'
// 1st
import { pool } from './util.js'
import { sql } from 'pg-extra'

////////////////////////////////////////////////////////////

export const insertView = async function(viewerId, viewedId) {
    assert(Number.isInteger(viewerId))
    assert(Number.isInteger(viewedId))
    return pool.query(sql`
    INSERT INTO profile_views (viewer_id, viewed_id)
    VALUES (${viewerId}, ${viewedId})
  `)
}

export const getLatestViews = async function(viewedId) {
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
