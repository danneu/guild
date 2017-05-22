'use strict'
// 3rd
const Router = require('koa-router')
const debug = require('debug')('app:routes:index')
// 1st
const cancan = require('../cancan')
const db = require('../db')
const cache2 = require('../cache2')
const pre = require('../presenters')

////////////////////////////////////////////////////////////

const router = new Router()

////////////////////////////////////////////////////////////

// Depends on FAQ_POST_ID
router.get('/faq', async (ctx) => {
  const post = pre.presentPost(cache2.get('faq-post'))

  await ctx.render('faq', {
    ctx,
    post,
    title: 'FAQ'
  })
})

////////////////////////////////////////////////////////////

module.exports = router
