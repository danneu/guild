'use strict';
// 3rd
const assert = require('better-assert');
const debug = require('debug')('db:keyvals');
// 1st
const dbUtil = require('./util');
const pre = require('../presenters');

// String -> keyvals record object
exports.getRowByKey = function * (key) {
  assert(typeof key === 'string');
  const row = yield dbUtil.queryOne(`
    SELECT 
      *,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "updated_by"
    FROM keyvals 
    LEFT OUTER JOIN users ON keyvals.updated_by_id = users.id
    WHERE key = $1
  `, [key]);
  pre.presentKeyval(row);
  return row;
};

// String -> Undefined | JSValue
exports.getValueByKey = function * getValueByKey (key) {
  assert(typeof key === 'string');
  const row = yield exports.getRowByKey(key);
  return row && row.value;
};

// updatedById (Optional Int): user_id that's updating the row
exports.setKey = function * (key, value, updatedById) {
  debug('[setKey] key=%j, value=%j, updatedById=%j', key, value, updatedById);
  assert(typeof key === 'string');
  const sql = `
    UPDATE keyvals
    SET value = $2,
        updated_at = NOW(),
        updated_by_id = $3
    WHERE key = $1
  `;
  return yield dbUtil.query(sql, [key, value, updatedById]);
};
