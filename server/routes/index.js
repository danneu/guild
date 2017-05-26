'use strict'
// 3rd
const assert = require('better-assert')
const Router = require('koa-router')
const debug = require('debug')('app:routes:index')
const {sql,_raw} = require('pg-extra')
// 1st
const cancan = require('../cancan')
const db = require('../db')
const cache2 = require('../cache2')
const pre = require('../presenters')
const {pool} = require('../db/util')

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

async function listRoleplays (sort = 'latest-post', selectedTagIds = []) {
  assert(Array.isArray(selectedTagIds))

  const perPage = 20

  return pool.many(sql`
    SELECT
      t.*,
      t.tags,
      to_json(f.*) "forum",
      json_build_object(
        'uname', u.uname,
        'slug', u.slug
      ) "user",
      CASE
        WHEN ic_posts IS NULL THEN NULL
        ELSE json_build_object(
          'id', ic_posts.id,
          'created_at', ic_posts.created_at
        )
      END "latest_ic_post",
      CASE
        WHEN ic_users IS NULL THEN NULL
        ELSE json_build_object(
        'uname', ic_users.uname,
        'slug', ic_users.slug
        )
      END "latest_ic_user",
      CASE
        WHEN ooc_posts IS NULL THEN NULL
        ELSE json_build_object(
          'id', ooc_posts.id,
          'created_at', ooc_posts.created_at
        )
      END "latest_ooc_post",
      CASE
        WHEN ooc_users IS NULL THEN NULL
        ELSE json_build_object(
        'uname', ooc_users.uname,
        'slug', ooc_users.slug
        )
      END "latest_ooc_user",
      CASE
        WHEN char_posts IS NULL THEN NULL
        ELSE json_build_object(
          'id', char_posts.id,
          'created_at', char_posts.created_at
        )
      END "latest_char_post",
      CASE
        WHEN char_users IS NULL THEN NULL
        ELSE json_build_object(
        'uname', char_users.uname,
        'slug', char_users.slug
        )
      END "latest_char_user"
    FROM (
      SELECT
        topics.*,
        json_agg(tags.*) "tags"
      FROM topics
      JOIN tags_topics ON topics.id = tags_topics.topic_id
      JOIN tags ON tags_topics.tag_id = tags.id
      WHERE topics.forum_id IN (3, 4, 5, 6, 7, 42, 39)
        AND topics.is_hidden = false
    `.append(
      selectedTagIds.length > 0
      ? sql`AND tags_topics.tag_id = ANY (${selectedTagIds})`
      : _raw``
    )
    .append(sql`GROUP BY topics.id`)
    .append(
      sort === 'created'
      ? sql`ORDER BY topics.created_at DESC`
      : sql`ORDER BY topics.latest_post_id DESC`
    )
    .append(sql`
        LIMIT ${perPage}
      ) t
      JOIN users u ON t.user_id = u.id
      JOIN forums f ON t.forum_id = f.id
      JOIN posts latest_post ON t.latest_post_id = latest_post.id
      JOIN users u2 ON latest_post.user_id = u2.id
      LEFT OUTER JOIN posts ic_posts ON t.latest_ic_post_id = ic_posts.id
      LEFT OUTER JOIN users ic_users ON ic_posts.user_id = ic_users.id
      LEFT OUTER JOIN posts ooc_posts ON t.latest_ooc_post_id = ooc_posts.id
      LEFT OUTER JOIN users ooc_users ON ooc_posts.user_id = ooc_users.id
      LEFT OUTER JOIN posts char_posts ON t.latest_char_post_id = char_posts.id
      LEFT OUTER JOIN users char_users ON char_posts.user_id = char_users.id
    `)
    .append(
      sort === 'created'
      ? sql`ORDER BY t.created_at DESC`
      : sql`ORDER BY t.latest_post_id DESC`
    )
    .append(sql`LIMIT ${perPage}`)
  )
}

router.get('/roleplays', async (ctx) => {
  // TODO: MOve to cache2.once() and update on tag list edit
  const tagGroups = await db.findAllTagGroups()

  // Should always be array. Empty array means all tags (no tag filter).
  const selectedTagIds = ctx.validateQuery('tags')
    .defaultTo([])
    .toArray()
    .toInts()
    .val()

  const sort = ctx.validateQuery('sort')
    .tap((v) => ['latest-post', 'created'].includes(v) ? v : 'latest-post')
    .val()

  const roleplays = await listRoleplays(sort, selectedTagIds)
    .then((xs) => xs.map((x) => pre.presentTopic(x)))

  await ctx.render('list_roleplays', {
    ctx,
    roleplays,
    // tag filter
    sort,
    tagGroups,
    selectedTagIds
  })
})

////////////////////////////////////////////////////////////

module.exports = router
