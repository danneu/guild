// 3rd
const { assert } = require('../../util')
// 1st
const substring = require('./substring')
const akismet = require('./akismet')
const config = require('../../config')
const { broadcastAutoNuke } = require('../discord')
const db = require('../../db')
const emailer = require('../../emailer')

// Returns { test: 'SUBSTRING' | 'AKISMET', isSpam: Boolean, info: ... }
async function analyze(ctx, text) {
    // SUBSTRING check is too aggressive, too many false positives.

    // ;{
    //   const info = await substring.analyze(text)
    //
    //   console.log('antispam analyze (substring):', info)
    //
    //   if (info.isSpam) {
    //     return { isSpam: true, test: 'SUBSTRING', info }
    //   }
    // }

    {
        const info = await akismet.analyze(ctx, text)

        console.log('antispam analyze (akismet):', info)

        if (info === 'SPAM') {
            return { isSpam: true, test: 'AKISMET', info }
        }
    }

    return { isSpam: false }
}

// Returns falsey if they are not a spammer
async function process(ctx, markup, postId) {
    assert(ctx.currUser)
    assert(typeof markup === 'string')
    assert(Number.isInteger(postId))

    // Bail if user is approved or if they have more than 5 posts
    if (ctx.currUser.approved_at || ctx.currUser.posts_count > 5) {
        return
    }

    const result = await analyze(ctx, markup)

    console.log('antispam process:', result)

    // Not spam? Then nothing to do.
    if (!result.isSpam) {
        return
    }

    // It's spam, so nuke user, send email, and post in Discord
    await db.nukeUser({
        spambot: ctx.currUser.id,
        nuker: config.STAFF_REPRESENTATIVE_ID || 1,
    })

    // Send email (Turned off for now since it's redundant)
    // emailer.sendAutoNukeEmail(ctx.currUser.slug, markup)

    // Broadcast to Discord
    broadcastAutoNuke(ctx.currUser, postId, result).catch(err => {
        console.error('broadcastAutoNuke failed', err)
    })

    return result
}

module.exports = {
    analyze,
    process: async (ctx, markup, postId) => {
        return process(ctx, markup, postId)
            .then(result => {
                if (result) {
                    console.log('antispam process detected a spammer:', result)
                }
                return result
            })
            .catch(err => {
                console.error('antispam process error', err)
            })
    },
}
