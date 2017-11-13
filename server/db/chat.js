'use strict'
// 3rd
const assert = require('better-assert')
// 1st
const { pool } = require('./util')
const { sql } = require('pg-extra')

////////////////////////////////////////////////////////////

// Returns [{when: '2015-7-25', count: 64}, ...]
exports.getChatLogDays = async function() {
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
exports.findLogByDateTrunc = async function(when) {
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
