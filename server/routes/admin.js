'use strict'
// 3rd
const Router = require('koa-router')
const debug = require('debug')('app:routes:admin')
// 1st
const cancan = require('../cancan')
const db = require('../db')
const pre = require('../presenters')

////////////////////////////////////////////////////////////

const router = new Router()

////////////////////////////////////////////////////////////

router.post('/admin/users/merge', async (ctx) => {
  ctx.assert(ctx.currUser && ctx.currUser.role === 'admin')
  ctx.validateBody('main-slug')
    .isString()
    .trim()
    .checkPred((slug) => slug.length >= 3, 'main-slug required')
  ctx.validateBody('husk-slug')
    .isString()
    .trim()
    .checkPred((slug) => slug.length >= 3, 'husk-slug required')
  ctx.validateBody('confirm')
    .isString()
    .trim()
    .checkPred((slug) => slug.length >= 3, 'confirm required')
    .checkPred((slug) => slug === ctx.vals['main-slug'], 'confirm must match main slug')

  const mainUser = await db.findUserBySlug(ctx.vals['main-slug'])
    .then(pre.presentUser)
  const huskUser = await db.findUserBySlug(ctx.vals['husk-slug'])
    .then(pre.presentUser)

  ctx.validateBody('main-slug')
    .check(!!mainUser, 'user not found for main slug')
  ctx.validateBody('husk-slug')
    .check(!!huskUser, 'user not found for husk slug')

  await db.admin.mergeUsers({
    mainId: mainUser.id,
    huskId: huskUser.id
  })

  ctx.flash = {
    message: ['success', `${huskUser.uname} merged into ${mainUser.uname}`]
  }
  ctx.redirect(mainUser.url)
})

////////////////////////////////////////////////////////////

module.exports = router
