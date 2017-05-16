"use strict";
// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var RegexTrie = require('regex-trie');
var debug = require('debug')('app:cache');
var assert = require('better-assert');
const IntervalCache = require('interval-cache')
const {sql} = require('pg-extra')
const fetch = require('node-fetch')
// 1st party
var db = require('./db');
var pre = require('./presenters');
var config = require('./config');
const {pool} = require('./db/util')

const cache = new IntervalCache()
  // 5 minutes
  .every('staff', 1000 * 60 * 5, db.findStaffUsers, [])
  // 60 seconds
  .every('stats', 1000 * 60, () => db.getStats(), {
    topicsCount: 0,
    usersCount: 0,
    postsCount: 0,
    latestUser: null,
    onlineUsers: []
  })
  // 5 min
  .every('uname-regex-trie', 1000 * 60 * 5, async () => {
    console.log('[CACHE] Populating uname-regex-trie')
    const trie = new RegexTrie()
    const unames = await db.findAllUnames()
    trie.add(unames.map((uname) => uname.toLowerCase()))
    return trie
  }, new RegexTrie())
  // 10 seconds
  // Map of ForumId->Int (includes all ForumIds in database)
  .every('forum-viewer-counts', 1000 * 10, db.getForumViewerCounts, {})
  // 15 seconds
  .every('categories', 1000 * 15, db.findCategoriesWithForums, [])
  // 15 seconds
  .every('latest-checks', 1000 * 15, () => db.findLatestChecks(), [])
  .every('latest-roleplays', 1000 * 15, () => db.findLatestRoleplays(), [])
  .every('latest-statuses', 1000 * 15, () => db.findLatestStatuses(), [])
  // 60 minutes
  .every('unames->ids', 1000 * 60 * 60, db.getUnamesMappedToIds, {})
  // 60 minutes
  .every('arena-leaderboard', 1000 * 60 * 60, () => db.getArenaLeaderboard(5), [])
  // 45 seconds
  .every('current-sidebar-contest', 1000 * 45, () => {
    return db.getCurrentSidebarContest()
  }, null)
  // 30 seconds
  .every('global-alert', 1000 * 30, () => {
    return db.keyvals.getRowByKey('GLOBAL_ALERT')
  }, null)
  // 12 hours
  .every('sitemaps', 1000 * 60 * 60 * 12, async () => {
    console.log('[CACHE] Populating sitemap.txt')
    const MAX_SITEMAP_URLS = 50000
    const [topicUrls, userUrls] = await Promise.all([
      db.findAllPublicTopicUrls(),
      pool.many(sql`
        SELECT *
        FROM users
        WHERE is_nuked = false
        ORDER BY id
      `).then((users) => users.map((u) => pre.presentUser(u).url))
    ])

    const urls = [...userUrls, ...topicUrls].map((url) => {
      return config.HOST + url
    })

    const chunks = _.chunk(urls, 50000)

    console.log('Sitemap URLs: %j, Chunks: %j', urls.length, chunks.length);

    return chunks
  }, [])

if (config.CHAT_SERVER_URL) {
  // 12 seconds
  cache.every('chat-server-stats', 1000 * 12, async () => {
    return fetch(config.CHAT_SERVER_URL + '/stats')
      .then((res) => res.text())
      .then((json) => JSON.parse(json))
  }, { member_count: 0 })
} else {
  console.log('[cache.js] Skipping chat-server stats ping since CHAT_SERVER_URL is not set');
}


if (config.LATEST_RPGN_TOPIC_ID) {
  cache.every('latest-rpgn-topic', 1000 * 60, () => {
    return db.findRGNTopicForHomepage(config.LATEST_RPGN_TOPIC_ID)
  }, null)
}

module.exports = cache
