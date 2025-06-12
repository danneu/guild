'use strict'
// 3rd
import Router from '@koa/router'
// 1st
import * as db from '../db'
import { Context } from 'koa'

////////////////////////////////////////////////////////////

const router = new Router()

////////////////////////////////////////////////////////////

router.get('/chatlogs', async (ctx: Context) => {
    ctx.assertAuthorized(ctx.currUser, 'READ_CHATLOGS')
    const logs = await db.chat.getChatLogDays()
    await ctx.render('list_chatlogs', {
        ctx,
        logs,
    })
})

////////////////////////////////////////////////////////////

// :when is 'YYYY-MM-DD'
router.get('/chatlogs/:when', async (ctx: Context) => {
    // Temporarily disable
    ctx.assertAuthorized(ctx.currUser, 'READ_CHATLOGS')
    // TODO: Validate
    ctx.validateParam('when').match(/\d{4}-\d{2}-\d{2}/, 'Invalid date format')

    const log = await db.chat.findLogByDateTrunc(ctx.vals.when)
    ctx.assert(log, 404)
    ctx.assert(log.length > 0, 404)

    await ctx.render('show_chatlog', {
        ctx,
        log,
        when: log[0].when,
    })
})

////////////////////////////////////////////////////////////

export default router
