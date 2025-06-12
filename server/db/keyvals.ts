'use strict'
// 3rd
import assert from 'assert'
import createDebug from 'debug'; const debug = createDebug('app:db:keyvals')
// 1st
import { pool } from './util'
import { sql } from 'pg-extra'
import * as pre from '../presenters'

export const deleteKey = async key => {
    assert(typeof key === 'string')

    return pool.query(sql`
    DELETE FROM keyvals
    WHERE key = ${key}
  `)
}

// String -> keyvals record object
export const getRowByKey = async function(key) {
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
export const getValueByKey = async function(key) {
    assert(typeof key === 'string')
    const row = await getRowByKey(key)
    return row && row.value
}

// updatedById (Optional Int): user_id that's updating the row
export const setKey = async function(key, value, updatedById) {
    debug('[setKey] key=%j, value=%j, updatedById=%j', key, value, updatedById)
    assert(typeof key === 'string')

    if (typeof value !== 'string') {
        value = JSON.stringify(value)
    }

    return pool.query(sql`
    INSERT INTO keyvals (key, value, updated_at, updated_by_id)
    VALUES (${key}, ${value}, NOW(), ${updatedById})
    ON CONFLICT (key) DO UPDATE
    SET value = ${value},
        updated_at = NOW(),
        updated_by_id = ${updatedById}
    WHERE keyvals.key = ${key}
  `)
}
