'use strict'
// 3rd
import assert from 'assert'
// 1st
import { pool } from './util'

////////////////////////////////////////////////////////////

// Returns [{when: '2015-7-25', count: 64}, ...]
export const getChatLogDays = async function() {
    return pool.query(`
    SELECT to_char(sub.day, 'YYYY-MM-DD') "when", sub.count "count"
    FROM (
      SELECT date_trunc('day', cm.created_at) "day", COUNT(cm.*) "count"
      FROM chat_messages cm
      GROUP BY "day"
      ORDER BY "day"
    ) sub
  `).then(res => res.rows)
}

////////////////////////////////////////////////////////////

// `when` is string 'YYYY-MM-DD'
export const findLogByDateTrunc = async function(when) {
    assert(typeof when === 'string')
    return pool.query(`
    SELECT sub.*
    FROM (
      SELECT
        to_char(date_trunc('day', cm.created_at), 'YYYY-MM-DD') "when",
        cm.*,
        u.uname "uname"
      FROM chat_messages cm
      LEFT OUTER JOIN users u ON cm.user_id = u.id
    ) sub
    WHERE sub.when = $1
    ORDER BY sub.id
  `, [when]).then(res => res.rows)
}
