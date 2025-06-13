// 3rd party
import _ from 'lodash'
import RegexTrie from 'regex-trie'
// import createDebug from 'debug'
// const debug = createDebug('app:cache')
// 1st party
import IntervalCache from '../lib/interval-cache'
import * as db from './db/index.js'
import * as pre from './presenters.js'
import * as config from './config.js'

const cache = new IntervalCache()
    // 5 minutes
    .every('staff', 1000 * 60 * 5, db.findStaffUsers, [])
    // 60 seconds
    .every('stats', 1000 * 60, () => db.getStats(), {
        topicsCount: 0,
        usersCount: 0,
        postsCount: 0,
        latestUser: null,
        onlineUsers: [],
    })
    // 5 min
    .every(
        'uname-regex-trie',
        1000 * 60 * 5,
        async () => {
            const trie = new RegexTrie()
            const unames = await db.findAllUnames()
            trie.add(unames.map(uname => uname.toLowerCase()))
            return trie
        },
        new RegexTrie()
    )
    // 10 seconds
    // Map of ForumId->Int (includes all ForumIds in database)
    .every('forum-viewer-counts', 1000 * 10, db.getForumViewerCounts, {})
    // 15 seconds
    .every(
        'categories',
        1000 * 15,
        () => {
            return db
                .findCategoriesWithForums()
                .then(xs => xs.map(x => pre.presentCategory(x)))
        },
        []
    )
    // 15 seconds
    .every('latest-checks', 1000 * 15, () => db.findLatestChecks(), [])
    .every('latest-roleplays', 1000 * 15, () => db.findLatestRoleplays(), [])
    .every('latest-statuses', 1000 * 15, () => db.findLatestStatuses(), [])
    // 60 minutes
    .every('unames->ids', 1000 * 60 * 60, db.getUnamesMappedToIds, {})
    // 45 seconds
    .every(
        'current-sidebar-contest',
        1000 * 45,
        () => {
            return db.getCurrentSidebarContest()
        },
        null
    )
    // 12 hours
    .every(
        'sitemaps',
        1000 * 60 * 60 * 12,
        async () => {
          return [];
      //       // console.log('[CACHE] Populating sitemap.txt')
      //       const MAX_SITEMAP_URLS = 50000
      //
      //       const staticPaths = ['/faq']
      //
      //       const [topicUrls, userUrls] = await Promise.all([
      //           db.findAllPublicTopicUrls(),
      //           pool
      //               .many(
      //                   sql`
      //   SELECT *
      //   FROM users
      //   WHERE is_nuked = false
      //   ORDER BY id
      // `
      //               )
      //               .then(users => users.map(u => pre.presentUser(u).url)),
      //       ])
      //
      //       const urls = [...staticPaths, ...userUrls, ...topicUrls].map(
      //           url => {
      //               return config.HOST + url
      //           }
      //       )
      //
      //       const chunks = _.chunk(urls, 50000)
      //
      //       console.log(
      //           'Sitemap URLs: %j, Chunks: %j',
      //           urls.length,
      //           chunks.length
      //       )
      //
      //       return chunks
        },
        []
    )

if (typeof config.LATEST_RPGN_TOPIC_ID === 'number') {
    const id = config.LATEST_RPGN_TOPIC_ID
    cache.every(
        'latest-rpgn-topic',
        1000 * 60,
        () => {
            return db.findRGNTopicForHomepage(id)
        },
        null
    )
}

cache.start()

export default cache
