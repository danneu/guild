// 3rd
// import createDebug from 'debug'
// const debug = createDebug('app:db:profile-views')
import assert from 'assert'
// 1st
import { pool } from './util.js'

////////////////////////////////////////////////////////////

export const insertView = async function(viewerId, viewedId) {
    assert(Number.isInteger(viewerId))
    assert(Number.isInteger(viewedId))
    return pool.query(`
    INSERT INTO profile_views (viewer_id, viewed_id)
    VALUES ($1, $2)
  `, [viewerId, viewedId])
}

export const getLatestViews = async function(viewedId) {
    assert(Number.isInteger(viewedId))

    return pool.query(`
    SELECT viewers.uname
          , viewers.slug
          , viewers.avatar_url
          , MAX(pv.created_at) as "maxstamp"
    FROM profile_views pv
    JOIN users viewers ON pv.viewer_id = viewers.id
    WHERE pv.viewed_id = $1
    GROUP BY viewers.uname, viewers.slug, viewers.avatar_url
    ORDER BY maxstamp DESC
    LIMIT 10
 `, [viewedId]).then(res => res.rows)
}
