'use strict';
// 3rd
const assert = require('better-assert')
const debug = require('debug')('db:keyvals')
// 1st
const {pool} = require('./util')
const {sql} = require('pg-extra')
const pre = require('../presenters')

// String -> keyvals record object
exports.getRowByKey = async function (key) {
  debug(`[getRowByKey] key=${key}`)
  assert(typeof key === 'string')
  const row = await pool.one(sql`
    SELECT
      *,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "updated_by"
    FROM keyvals
    LEFT OUTER JOIN users ON keyvals.updated_by_id = users.id
    WHERE key = ${key}
  `)

  pre.presentKeyval(row)

  return row
}

// String -> Undefined | JSValue
exports.getValueByKey = async function (key) {
  assert(typeof key === 'string')
  const row = await exports.getRowByKey(key)
  return row && row.value
}

// updatedById (Optional Int): user_id that's updating the row
exports.setKey = async function (key, value, updatedById) {
  debug('[setKey] key=%j, value=%j, updatedById=%j', key, value, updatedById)
  assert(typeof key === 'string')

  return pool.query(sql`
    UPDATE keyvals
    SET value = ${value},
        updated_at = NOW(),
        updated_by_id = ${updatedById}
    WHERE key = ${key}
  `)
}
