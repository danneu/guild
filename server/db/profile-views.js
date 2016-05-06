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
    SELECT DISTINCT sub.*
    FROM (
      SELECT viewers.*
      FROM profile_views pv
      JOIN users viewers ON pv.viewer_id = viewers.id
      WHERE pv.viewed_id = $1
      ORDER BY pv.created_at
    ) sub
    LIMIT 10
  `, [viewedId]);
  return rows;
};
