import { createIntervalCache } from "./cache3/index";
import * as config from "./config";
import * as db from "./db";
import * as pre from "./presenters";

const cache = createIntervalCache({
  staff: {
    enabled: true,
    initialValue: [],
    interval: 1000 * 60 * 5, // 5 minutes
    fetch: () => db.findStaffUsers(),
  },

  stats: {
    enabled: true,
    initialValue: {
      topicsCount: 0,
      usersCount: 0,
      postsCount: 0,
      latestUser: null,
      onlineUsers: [],
    },
    interval: 1000 * 60, // 60 seconds
    fetch: () => db.getStats(),
  },

  // This must be updated manually on user change (register, nuke)
  //
  // TODO:
  //
  // - [x]: register
  // - [ ]: nuke
  "uname-set": {
    enabled: true,
    initialValue: new Set(),
    // interval: 1000 * 60 * 5, // 5 minutes
    interval: Infinity,
    fetch: async () => {
      const unames = await db.findAllActiveUnames();
      console.log("unames", unames);
      return new Set(unames.map((uname) => uname.toLowerCase()));
    },
  },

  "forum-viewer-counts": {
    enabled: true,
    initialValue: {},
    interval: 1000 * 10, // 10 seconds
    fetch: () => db.getForumViewerCounts(),
  },

  categories: {
    enabled: true,
    initialValue: [],
    interval: 1000 * 15, // 15 seconds
    fetch: () =>
      db
        .findCategoriesWithForums()
        .then((xs) => xs.map((x) => pre.presentCategory(x))),
  },

  "latest-checks": {
    enabled: true,
    initialValue: [],
    interval: 1000 * 15, // 15 seconds
    fetch: () => db.findLatestChecks(),
  },

  "latest-roleplays": {
    enabled: true,
    initialValue: [],
    interval: 1000 * 15, // 15 seconds
    fetch: () => db.findLatestRoleplays(),
  },

  "latest-statuses": {
    enabled: true,
    initialValue: [],
    interval: 1000 * 15, // 15 seconds
    fetch: () => db.findLatestStatuses(),
  },

  "unames->ids": {
    enabled: true,
    initialValue: {},
    interval: 1000 * 60 * 60, // 60 minutes
    fetch: () => db.getUnamesMappedToIds(),
  },

  "current-sidebar-contest": {
    enabled: true,
    initialValue: null,
    interval: 1000 * 45, // 45 seconds
    fetch: () => db.getCurrentSidebarContest(),
  },

  "latest-rpgn-topic": {
    enabled: typeof config.LATEST_RPGN_TOPIC_ID === "number",
    initialValue: null,
    interval: 1000 * 60, // 1 minute
    fetch: () => db.findRGNTopicForHomepage(config.LATEST_RPGN_TOPIC_ID!),
  },

  // from cache2

  "forum-mods": {
    enabled: true,
    initialValue: Object.create(null),
    interval: 1000 * 60 * 10,
    fetch: async () => {
      // maps forumId -> [User]
      const mapping: Record<number, any[]> = Object.create(null);
      const rows = await db.allForumMods();
      rows.forEach((row) => {
        mapping[row.forum_id] = [row.user];
      });
      return mapping;
    },
  },

  "faq-post": {
    enabled: !!config.FAQ_POST_ID,
    initialValue: null,
    interval: 1000 * 60 * 60,
    fetch: async () => {
      return db.findPostById(config.FAQ_POST_ID);
    },
  },

  "welcome-post": {
    enabled: !!config.WELCOME_POST_ID,
    initialValue: null,
    interval: Infinity,
    fetch: async () => {
      return db.findPostById(config.WELCOME_POST_ID);
    },
  },

  sitemaps: {
    enabled: true,
    initialValue: [],
    interval: 1000 * 60 * 60 * 12, // 12 hours
    fetch: async () => {
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
      return [];
    },
  },

  "discord-stats": {
    enabled: false,
    initialValue: { online: 0 },
    interval: 1000 * 60,
    fetch: async () => {
      // const result = await client.getGuildEmbed(config.DISCORD_GUILD_ID);
      // return { online: result.presence_count };
      return { online: 0 };
    },
  },

  // new

  // TODO: Update on tag list edit
  "tag-groups": {
    enabled: true,
    initialValue: [],
    interval: 1000 * 60 * 10, // 10 minutes
    fetch: () => db.findAllTagGroups(),
  },
});

export default cache;
