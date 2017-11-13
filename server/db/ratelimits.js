'use strict'
// 3rd
const assert = require('better-assert')
const debug = require('debug')('db:ratelimits')
const _ = require('lodash')
// 1st
const { pool } = require('./util')
const { sql } = require('pg-extra')

// maxDate (Required Date): the maximum, most recent timestamp that the user
// can have if they have a row in the table. i.e. if user can only post
// every 5 minutes, maxDate will be 5 min in the past.
//
// If user is ratelimited, it throws the JSDate that the ratelimit expires
// that can be shown to the user (e.g. try again in 24 seconds)
exports.bump = async function(userId, ipAddress, maxDate) {
    debug(
        '[bump] userId=%j, ipAddress=%j, maxDate=%j',
        userId,
        ipAddress,
        maxDate
    )
    assert(Number.isInteger(userId))
    assert(typeof ipAddress === 'string')
    assert(_.isDate(maxDate))

    const sqls = {
        recentRatelimit: sql`
      SELECT *
      FROM ratelimits
      WHERE ip_root(ip_address) = ip_root(${ipAddress})
      ORDER BY id DESC
      LIMIT 1
    `,
        insertRatelimit: sql`
      INSERT INTO ratelimits (user_id, ip_address) VALUES
      (${userId}, ${ipAddress})
    `,
    }

    return pool.withTransaction(async client => {
        // Temporarily disabled as a longshot attempt to prevent issue
        // -- yield client.queryPromise('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        // Get latest ratelimit for this user
        const row = await client.one(sqls.recentRatelimit)
        // If it's too soon, throw the Date when ratelimit expires
        if (row && row.created_at > maxDate) {
            const elapsed = new Date() - row.created_at // since ratelimit
            const duration = new Date() - maxDate // ratelimit length
            const expires = new Date(Date.now() + duration - elapsed)
            throw expires
        }
        // Else, insert new ratelimit
        return client.query(sqls.insertRatelimit)
    })
}
