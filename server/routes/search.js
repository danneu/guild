'use strict'
// 3rd
const Router = require('koa-router')
const knex = require('knex')({ client: 'pg' })
const {_raw} = require('pg-extra')
const debug = require('debug')('app:search')
// 1st
const {pool} = require('../db/util')
const cache = require('../cache')
const pre = require('../presenters')

////////////////////////////////////////////////////////////

const router = new Router()

////////////////////////////////////////////////////////////

// Query
// - term (optional): search phrase
// - topic_id (optional)
// - post_types (optional)
// - forum_ids (optional)
// - user_ids (optional)
// ----
// - page
//
// TODO: Remove the old CloudSearch cruft from search_results.html and anywhere
// else in the codebase.
router.get('/search', async (ctx) => {
  // Must be logged in to search
  if (!ctx.currUser) {
    ctx.flash = { message: ['danger', 'You must be logged in to search'] }
    ctx.redirect('/')
    return
  }

  ctx.set('X-Robots-Tag', 'noindex')

  // TODO: Stop hard-coding lexus lounge authorization
  // Ignore lexus-lounge and test categories
  const publicCategories = cache.get('categories').filter((c) => {
    return c.id !== 4 && c.id !== 5
  })

  const perPage = 50

  const page = ctx.validateQuery('page')
    .defaultTo(1)
    .toInt()
    .tap((n) => Math.max(n, 0))
    .tap((n) => Math.min(n, 1000 / perPage))
    .val()

  // If no search query, then short-circuit the DB hit
  if (Object.keys(ctx.query).length === 0) {
    await ctx.render('search_results', {
      ctx,
      posts: [],
      className: 'search',
      searchParams: {},
      reactData: {
        searchParams: {},
        categories: publicCategories
      }
    })
    return
  }

  const term = ctx.validateQuery('term')
    .optional()
    .toString()
    .trim()
    .val()

  const topicId = ctx.validateQuery('topic_id')
    .optional()
    .toInt()
    .val()

  // TODO: Filter out lexus-lounge forums
  const forumIds = ctx.validateQuery('forum_ids')
    .optional()
    .toArray()
    .toInts()
    .val()

  const unamesToIds = cache.get('unames->ids')

  const unames = ctx.validateQuery('unames')
    .optional()
    .toArray()
    .uniq()
    // Remove unames that are not in our system
    .tap((unames) => {
      return unames
        .filter((uname) => unamesToIds[uname.toLowerCase()])
    })
    .val()

  const userIds = unames && unames.length > 0
    ? unames.map((uname) => unamesToIds[uname.toLowerCase()])
    : undefined

  const postTypes = ctx.validateQuery('post_types')
    .optional()
    .toArray()
    .val()

  // Now we build the query

  const subquery = knex('posts')
    .select('posts.*')
    .select(knex.raw('to_json(users.*) "user"'))
    .select(knex.raw('to_json(topics.*) "topic"'))
    .select(knex.raw('to_json(forums.*) "forum"'))
    .innerJoin('users', 'users.id', 'posts.user_id')
    .innerJoin('topics', 'topics.id', 'posts.topic_id')
    .innerJoin('forums', 'forums.id', 'topics.forum_id')
    .where('posts.is_hidden', false)
    .whereNotNull('posts.markup')
    .limit(1000)

  if (term) {
    subquery.whereRaw(`to_tsvector('english', posts.markup) @@ plainto_tsquery('english', ?)`, [term])
  } else {
    subquery.orderBy('posts.id', 'desc')
  }

  // Extra filters

  if (topicId) {
    console.log({topicId})
    subquery.where('posts.topic_id', topicId)
  }

  // If post_type (array) is given
  if (postTypes) {
    console.log({postTypes})
    subquery.whereIn('posts.type', postTypes)
  }

  if (forumIds) {
    console.log({forumIds})
    subquery.whereIn('topics.forum_id', forumIds)
  }

  if (userIds) {
    console.log({userIds})
    subquery.whereIn('posts.user_id', userIds)
  }

  const query = knex
    .select('x.*')
    .from(subquery.as('x'))
    .limit(perPage)
    .offset((page - 1) * perPage)


  if (term) {
    query
      .select(knex.raw(`ts_rank(to_tsvector('english', x.markup), plainto_tsquery('english', ?)) "rank"`, [term]))
      .select(knex.raw(`ts_headline('english', x.markup, plainto_tsquery('english', ?)) "highlight"`, [term]))
      .orderBy('rank', 'desc')
  } else {
    // query.orderBy('x.id', 'desc')
  }

  debug(query.toString())

  const posts = await pool.many(_raw`${query.toString()}`)
    .then((xs) => xs.map((x) => pre.presentPost(x)))

  ctx.set('X-Robots-Tag', 'noindex')

  const params = {
    unames,
    term,
    topic_id: topicId,
    forum_ids: forumIds,
    post_types: postTypes
  }

  await ctx.render('search_results', {
    ctx,
    posts,
    page,
    perPage,
    className: 'search',
    searchParams: params,
    reactData: {
      searchParams: params,
      categories: publicCategories
    }
  })
})

////////////////////////////////////////////////////////////

module.exports = router
