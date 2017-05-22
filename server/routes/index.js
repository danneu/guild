'use strict'
// 3rd
const Router = require('koa-router')
const debug = require('debug')('app:routes:index')
// 1st
const cancan = require('../cancan')
const db = require('../db')
const cache2 = require('../cache2')

////////////////////////////////////////////////////////////

const router = new Router()

////////////////////////////////////////////////////////////

// Depends on FAQ_POST_ID
router.get('/faq', async (ctx) => {
  const post = cache2.get('faq-post')

  const html = post
    ? post.html
    : 'FAQ_POST_ID post has not yet been configured'

  await ctx.render('faq', {
    ctx,
    html,
    title: 'FAQ'
  })
})

////////////////////////////////////////////////////////////

module.exports = router
