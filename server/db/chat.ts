'use strict'
// 3rd
import assert from 'assert'
// 1st
import { pool } from './util'
import { sql } from 'pg-extra'

////////////////////////////////////////////////////////////

// Returns [{when: '2015-7-25', count: 64}, ...]
export const getChatLogDays = async function() {
    return pool.many(sql`
    SELECT to_char(sub.day, 'YYYY-MM-DD') "when", sub.count "count"
    FROM (
      SELECT date_trunc('day', cm.created_at) "day", COUNT(cm.*) "count"
      FROM chat_messages cm
      GROUP BY "day"
      ORDER BY "day"
    ) sub
  `)
}

////////////////////////////////////////////////////////////

// `when` is string 'YYYY-MM-DD'
export const findLogByDateTrunc = async function(when) {
    assert(typeof when === 'string')
    return pool.many(sql`
    SELECT sub.*
    FROM (
      SELECT
        to_char(date_trunc('day', cm.created_at), 'YYYY-MM-DD') "when",
        cm.*,
        u.uname "uname"
      FROM chat_messages cm
      LEFT OUTER JOIN users u ON cm.user_id = u.id
    ) sub
    WHERE sub.when = ${when}
    ORDER BY sub.id
  `)
}
