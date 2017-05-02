"use strict";
// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var RegexTrie = require('regex-trie');
var debug = require('debug')('app:cache');
var assert = require('better-assert');
const IntervalCache = require('interval-cache')
// 1st party
var db = require('./db');
var pre = require('./presenters');
var config = require('./config');
var belt = require('./belt');

const cache = new IntervalCache()
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
  .every('forum-viewer-counts', 1000 * 10, () => {
    return db.getForumViewerCounts()
  }, { users: [], guests: [] })
  // 15 seconds
  .every('categories', 1000 * 15, () => db.findCategoriesWithForums(), [])
  // 15 seconds
  .every('latest-checks', 1000 * 15, () => db.findLatestChecks(), [])
  .every('latest-roleplays', 1000 * 15, () => db.findLatestRoleplays(), [])
  .every('latest-statuses', 1000 * 15, () => db.findLatestStatuses(), [])
  // 60 minutes
  .every('unames->ids', 1000 * 60 * 60, () => {
    console.log('[CACHE] Populating unames->ids')
    return db.getUnamesMappedToIds()
  }, {})
  // 60 minutes
  .every('arena-leaderboard', 1000 * 60 * 60, () => db.getArenaLeaderboard(5), [])
  // 45 seconds
  .every('current-sidebar-contest', 1000 * 45, () => {
    return db.getCurrentSidebarContest()
  }, null)
  // 12 hours
  .every('sitemap.txt', 1000 * 60 * 60 * 12, async () => {
    console.log('[CACHE] Populating sitemap.txt')
    const MAX_SITEMAP_URLS = 50000
    const [publicTopicUrls, users] = await Promise.all([
      db.findAllPublicTopicUrls(),
      db.findAllUsers()
    ])
    const urls = users.map((user) => {
      return pre.presentUser(user).url
    }).concat(publicTopicUrls).map((url) => {
      return config.HOST + url
    })
    console.log('Sitemap URLs: %s', urls.length);

    if (urls.length > MAX_SITEMAP_URLS) {
      console.warn(`Too many sitemap URLs, only using the first ${MAX_SITEMAP_URLS}`)
    }

    return urls.slice(0, MAX_SITEMAP_URLS).join('\n')
  }, '')

if (config.CHAT_SERVER_URL) {
  // 12 seconds
  cache.every('chat-server-stats', 1000 * 12, async () => {
    return belt.request(config.CHAT_SERVER_URL + '/stats')
      .then((response) => {
        // Only update on successful response
        if (response.statusCode === 200) {
          return JSON.parse(response.body)
        }
        // TODO: Support `return this.val` for returning prev val
        return { member_count: -1 }
      })
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
