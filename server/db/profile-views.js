'use strict';
// 3rd
const debug = require('debug')('app:db:profile-views');
const assert = require('better-assert');
// 1st
const util = require('./util');

////////////////////////////////////////////////////////////

exports.insertView = function * (viewerId, viewedId) {
  assert(Number.isInteger(viewerId));
  assert(Number.isInteger(viewedId));
  return yield util.query(`
    INSERT INTO profile_views (viewer_id, viewed_id)
    VALUES ($1, $2)
  `, [viewerId, viewedId]);
};

exports.getLatestViews = function * (viewedId) {
  assert(Number.isInteger(viewedId));
  const rows = yield util.queryMany(`
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
  `, [viewedId]);
  return rows;
};
