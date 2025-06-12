// 3rd
import { v7 as uuidv7 } from 'uuid'
import createDebug from 'debug'
const debug = createDebug('app:middleware:track')
// 1st
import * as db from '../db'
import { isValidUuid, futureDate } from '../belt.js'
import * as config from '../config'
import { Context, Next } from 'koa'

export default ({ cookieKey = 't', interval = 5000 } = {}) => {
    debug('initializing track middleware')
    let queue: any[] = []

    const clearQueue = (): void => {
        if (queue.length === 0) {
            setTimeout(clearQueue, interval)
            return
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

    return async (ctx: Context, next: Next) => {
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
            track = uuidv7()
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
