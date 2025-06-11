'use strict'
// 3rd
const uuid = require('uuid')
const debug = require('debug')('app:middleware:track')
// 1st
const db = require('../db')
const { isValidUuid, futureDate } = require('../belt')
const config = require('../config')

module.exports = ({ cookieKey = 't', interval = 5000 } = {}) => {
    debug('initializing track middleware')
    let queue = []

    const clearQueue = () => {
        if (queue.length === 0) {
            return setTimeout(clearQueue, interval)
        }

        const hits = queue.slice()
        queue = []

        db.hits.insertHits(hits).then(
            () => {
                debug(`[clearQueue] ${hits.length} hits inserted`)
                setTimeout(clearQueue, interval)
            },
            err => {
                console.error('[track middleware] error inserting hits', err)
                setTimeout(clearQueue, interval)
            }
        )
    }

    // Start loop
    setTimeout(clearQueue, interval)

    return async (ctx, next) => {
        // Skip guests
        if (!ctx.currUser) {
            return next()
        }

        // Skip cloaked users
        if (config.CLOAKED_SLUGS.includes(ctx.currUser.slug)) {
            return next()
        }

        let track

        if (isValidUuid(ctx.cookies.get(cookieKey))) {
            track = ctx.cookies.get(cookieKey)
        } else {
            track = uuid.v7()
            ctx.cookies.set(cookieKey, track, {
                expires: futureDate({ years: 1 }),
            })
        }

        // Expose track downstream
        ctx.state.track = track

        await next()

        // Wait til after downstream so that we don't
        // push a hit on errors.
        queue.push({
            user_id: ctx.currUser.id,
            ip_address: ctx.ip,
            track,
        })
    }
}
