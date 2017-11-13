'use strict'
// 3rd
const Router = require('koa-router')
const debug = require('debug')('app:routes:topics')
// 1st
const cancan = require('../cancan')
const db = require('../db')
const pre = require('../presenters')
const config = require('../config')
const bbcode = require('../bbcode')

////////////////////////////////////////////////////////////

const router = new Router()

////////////////////////////////////////////////////////////

// Create the tab's 0th post
//
// Body:
// - markup
router.post('/topics/:topicId/:postType/0th', async ctx => {
    const { postType } = ctx.params
    ctx.assert(['ic', 'ooc', 'char'].includes(postType), 404)

    const topicId = Number.parseInt(ctx.params.topicId, 10)
    ctx.assert(!Number.isNaN(topicId), 404)

    const topic = await db.findTopicById(topicId).then(pre.presentTopic)
    ctx.assert(topic, 404)

    ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC', topic)

    ctx
        .validateBody('markup')
        .isString('Post is required')
        .trim()
        .isLength(
            config.MIN_POST_LENGTH,
            config.MAX_POST_LENGTH,
            'Post must be between ' +
                config.MIN_POST_LENGTH +
                ' and ' +
                config.MAX_POST_LENGTH +
                ' chars'
        )

    const redirectTo = `${topic.url}/${postType}`

    const post = await db
        .createPost({
            userId: ctx.currUser.id,
            ipAddress: ctx.ip,
            markup: ctx.vals.markup,
            html: bbcode(ctx.vals.markup),
            topicId: topic.id,
            isRoleplay: true,
            type: postType,
            idx: -1,
        })
        .catch(err => {
            if (err.code === '23505') {
                ctx.flash = {
                    message: [
                        'danger',
                        `0th post for this tab already exists.`,
                    ],
                }
                ctx.redirect(redirectTo)
                return
            }
            throw err
        })

    ctx.flash = { message: ['success', `Created 0th post for ${postType} tab`] }
    ctx.redirect(redirectTo)
})

////////////////////////////////////////////////////////////

module.exports = router
