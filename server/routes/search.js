'use strict'
// 3rd
const Router = require('koa-router')
const knex = require('knex')({ client: 'pg' })
const {_raw} = require('pg-extra')
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

  //return ctx.body = {term, topicId, userIds, postType}

  console.log({
    term, topicId, userIds, postTypes, forumIds
  })

  // Now we build the query

  const query = knex('posts')
    .select('posts.*')
    .select(knex.raw('to_json(users.*) "user"'))
    .select(knex.raw('to_json(topics.*) "topic"'))
    .select(knex.raw('to_json(forums.*) "forum"'))
    .innerJoin('users', 'users.id', 'posts.user_id')
    .innerJoin('topics', 'topics.id', 'posts.topic_id')
    .innerJoin('forums', 'forums.id', 'topics.forum_id')
    // Ignore test forum and lexus-lounge
    .whereNotIn('forums.category_id', [5, 4])
    // Hit full-text index
    .where('posts.is_hidden', false)
    .whereNotNull('posts.markup')
    .limit(50)

  // If term is truthy, we're doing a fulltext search

  if (term) {
    query.whereRaw(`to_tsvector('english', strip_quotes(posts.markup)) @@ plainto_tsquery('english', ?)`, [term])
    query.select(knex.raw(`ts_rank(to_tsvector('english', strip_quotes(posts.markup)), plainto_tsquery('english', ?)) "rank"`, [term]))
    query.select(knex.raw(`ts_headline('english', strip_quotes(posts.markup), plainto_tsquery('english', ?)) "highlight"`, [term]))
    // Sort by relevance
    query.orderBy('rank', 'desc')
  } else {
    // If no term, then we show markup
    query.orderBy('posts.created_at', 'desc')
  }

  // If topic_id is given, we want to search a single topic

  if (topicId) {
    console.log({topicId})
    query.where('posts.topic_id', topicId)
  }

  // If post_type (array) is given
  if (postTypes) {
    console.log({postTypes})
    query.whereIn('posts.type', postTypes)
  }

  if (forumIds) {
    console.log({forumIds})
    query.whereIn('topics.forum_id', forumIds)
  }

  if (userIds) {
    console.log({userIds})
    query.whereIn('posts.user_id', userIds)
  }

  console.log(query.toString())

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
    className: 'search',
    searchParams: params,
    searchResultsPerPage: 50,
    reactData: {
      searchParams: params,
      categories: publicCategories
    }
  })
})

////////////////////////////////////////////////////////////

module.exports = router
