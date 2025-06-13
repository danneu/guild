'use strict'
// 3rd
import assert from 'assert'
import createDebug from 'debug'; const debug = createDebug('db:ratelimits')
import _ from 'lodash'
// 1st
import { pool, maybeOneRow } from './util'

// maxDate (Required Date): the maximum, most recent timestamp that the user
// can have if they have a row in the table. i.e. if user can only post
// every 5 minutes, maxDate will be 5 min in the past.
//
// If user is ratelimited, it throws the JSDate that the ratelimit expires
// that can be shown to the user (e.g. try again in 24 seconds)
export const bump = async function(userId, ipAddress, maxDate) {
    debug(
        '[bump] userId=%j, ipAddress=%j, maxDate=%j',
        userId,
        ipAddress,
        maxDate
    )
    assert(Number.isInteger(userId))
    assert(typeof ipAddress === 'string')
    assert(_.isDate(maxDate))

    const recentRatelimitQuery = `
      SELECT *
      FROM ratelimits
      WHERE ip_root(ip_address) = ip_root($1)
      ORDER BY id DESC
      LIMIT 1
    `
    const insertRatelimitQuery = `
      INSERT INTO ratelimits (user_id, ip_address) VALUES
      ($1, $2)
    `

    return pool.withTransaction(async client => {
        // Temporarily disabled as a longshot attempt to prevent issue
        // -- yield client.queryPromise('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        // Get latest ratelimit for this user
        const row = await client.query(recentRatelimitQuery, [ipAddress]).then(maybeOneRow)
        // If it's too soon, throw the Date when ratelimit expires
        if (row && row.created_at > maxDate) {
            const elapsed = Date.now() - row.created_at.getTime() // since ratelimit
            const duration = Date.now() - maxDate // ratelimit length
            const expires = new Date(Date.now() + duration - elapsed)
            throw expires
        }
        // Else, insert new ratelimit
        return client.query(insertRatelimitQuery, [userId, ipAddress])
    })
}
