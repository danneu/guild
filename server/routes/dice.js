'use strict'
// 3rd
const assert = require('better-assert')
const Router = require('@koa/router')
const debug = require('debug')('app:routes:dice')
// 1st
const db = require('../db')
const pre = require('../presenters')

// HELPERS

async function loadCampaign(ctx, next) {
    const campaign = await db.dice.getCampaign(ctx.params.campaign_id)
    ctx.assert(campaign, 404)
    pre.presentCampaign(campaign)
    ctx.state.campaign = campaign
    return next()
}

async function loadRoll(ctx, next) {
    const roll = await db.dice.getRoll(ctx.params.roll_id)
    ctx.assert(roll, 404)
    pre.presentRoll(roll)
    ctx.state.roll = roll
    return next()
}

////////////////////////////////////////////////////////////

const router = new Router()

// List all dice campaigns/rolls
//
router.get('/campaigns', async ctx => {
    const campaigns = await db.dice.listCampaignsByActivity()
    campaigns.forEach(pre.presentCampaign)
    let myCampaigns = []
    if (ctx.currUser) {
        myCampaigns = await db.dice.getCampaignsForUser(ctx.currUser.id)
        myCampaigns.forEach(pre.presentCampaign)
    }
    // RESPOND
    await ctx.render('dice/list_campaigns', {
        ctx,
        campaigns,
        myCampaigns,
        title: 'All Campaigns',
    })
})

// Create campaign
//
router.post('/campaigns', async ctx => {
    ctx.assertAuthorized(ctx.currUser, 'CREATE_CAMPAIGN')
    // VALIDATE
    ctx
        .validateBody('title')
        .isString()
        .trim()
        .isLength(1, 300)
    ctx
        .validateBody('markup')
        .isString()
        .trim()
        .isLength(0, 10000)
    // INSERT
    const campaign = await db.dice.insertCampaign(
        ctx.currUser.id,
        ctx.vals.title,
        ctx.vals.markup
    )
    // RESPOND
    pre.presentCampaign(campaign)
    ctx.flash = { message: ['success', 'Dice campaign created'] }
    ctx.redirect(campaign.url)
})

// Show campaign
//
router.get('/campaigns/:campaign_id', loadCampaign, async ctx => {
    ctx.assertAuthorized(ctx.currUser, 'READ_CAMPAIGN', ctx.state.campaign)
    // LOAD
    const rolls = await db.dice.getCampaignRolls(ctx.state.campaign.id)
    rolls.forEach(pre.presentRoll)
    // RESPOND
    await ctx.render('dice/show_campaign', {
        ctx,
        campaign: ctx.state.campaign,
        rolls,
        title: `Dice: ${ctx.state.campaign.title} by ${
            ctx.state.campaign.user.uname
        }`,
    })
})

// Create roll
//
router.post('/campaigns/:campaign_id/rolls', loadCampaign, async ctx => {
    // AUTHZ
    ctx.assertAuthorized(ctx.currUser, 'CREATE_ROLL', ctx.state.campaign)
    // VALIDATE
    ctx
        .validateBody('syntax')
        .isString()
        .isLength(1, 300)
    ctx
        .validateBody('note')
        .isString()
        .isLength(0, 300)
    // INSERT
    try {
        await db.dice.insertRoll(
            ctx.currUser.id,
            ctx.state.campaign.id,
            ctx.vals.syntax,
            ctx.vals.note
        )
    } catch (err) {
        console.log('err:', err)
        if (typeof err === 'string') {
            ctx.check(false, 'Dice error: ' + err)
        } else {
            throw err
        }
    }
    // RESPOND
    ctx.flash = { message: ['success', 'Roll created'] }
    ctx.redirect(ctx.state.campaign.url)
})

// Show roll
//
router.get('/rolls/:roll_id', loadRoll, async ctx => {
    await ctx.render('dice/show_roll', {
        ctx,
        campaign: ctx.state.roll.campaign,
        roll: ctx.state.roll,
    })
})

// Update campaign
//
router.put('/campaigns/:campaign_id', loadCampaign, async ctx => {
    // AUTHZ
    ctx.assertAuthorized(ctx.currUser, 'UPDATE_CAMPAIGN', ctx.state.campaign)
    // VALIDATE
    ctx
        .validateBody('title')
        .isString()
        .trim()
        .isLength(1, 300)
    ctx
        .validateBody('markup')
        .isString()
        .trim()
        .isLength(0, 10000)
    // SAVE
    await db.dice.updateCampaign(
        ctx.state.campaign.id,
        ctx.vals.title,
        ctx.vals.markup
    )
    // RESPOND
    ctx.flash = { message: ['success', 'Campaign updated'] }
    ctx.redirect(ctx.state.campaign.url)
})

////////////////////////////////////////////////////////////

module.exports = router
