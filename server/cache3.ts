import { createIntervalCache } from "./cache3/index";
import * as config from "./config";
import * as db from "./db";
import RegexTrie from "regex-trie";
import * as pre from "./presenters";

const cache = createIntervalCache({
  staff: {
    enabled: true,
    initialValue: [],
    interval: 1000 * 60 * 5, // 5 minutes
    fetch: db.findStaffUsers,
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
    fetch: db.getStats,
  },

  "uname-regex-trie": {
    enabled: true,
    initialValue: new RegexTrie(),
    interval: 1000 * 60 * 5, // 5 minutes
    fetch: async () => {
      const trie = new RegexTrie();
      const unames = await db.findAllUnames();
      trie.add(unames.map((uname) => uname.toLowerCase()));
      return trie;
    },
  },

  "forum-viewer-counts": {
    enabled: true,
    initialValue: {},
    interval: 1000 * 10, // 10 seconds
    fetch: db.getForumViewerCounts,
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
    fetch: db.findLatestChecks,
  },

  "latest-roleplays": {
    enabled: true,
    initialValue: [],
    interval: 1000 * 15, // 15 seconds
    fetch: db.findLatestRoleplays,
  },

  "latest-statuses": {
    enabled: true,
    initialValue: [],
    interval: 1000 * 15, // 15 seconds
    fetch: db.findLatestStatuses,
  },

  "unames->ids": {
    enabled: true,
    initialValue: {},
    interval: 1000 * 60 * 60, // 60 minutes
    fetch: db.getUnamesMappedToIds,
  },

  "current-sidebar-contest": {
    enabled: true,
    initialValue: null,
    interval: 1000 * 45, // 45 seconds
    fetch: db.getCurrentSidebarContest,
  },

  "latest-rpgn-topic": {
    enabled: typeof config.LATEST_RPGN_TOPIC_ID === "number",
    initialValue: null,
    interval: 1000 * 60, // 1 minute
    fetch: () => db.findRGNTopicForHomepage(config.LATEST_RPGN_TOPIC_ID!),
  },

  "faq-post": {
    enabled: config.FAQ_POST_ID,
    initialValue: null,
    interval: 1000 * 60 * 60,
    fetch: async () => {
      return db.findPostById(config.FAQ_POST_ID);
    },
  },

  "welcome-post": {
    enabled: config.WELCOME_POST_ID,
    initialValue: null,
    interval: Infinity,
    fetch: async () => {
      return db.findPostById(config.WELCOME_POST_ID);
    },
  },
});

export default cache;
