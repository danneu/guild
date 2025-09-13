// 3rd party
import _ from "lodash";
// import createDebug from 'debug'
// const debug = createDebug('app:presenters')
// 1st party
import * as belt from "./belt.js";
import * as config from "./config.js";
import { DbConvo, DbPm, DbUser } from "./dbtypes.js";

/*
   Presenters should mutate*return the obj passed in, and handle null
*/

// Util ////////////////////////////////////////////////////

// Ex: formatDate(d) -> '8 Dec 2014 16:24'
export function formatDate(d: Date) {
  // HACK: Help me realize when I call formatDate when there is no date in dev
  if (config.NODE_ENV === "development" && !d) {
    return "[DATE WAS UNDEFINED]";
  }

  var months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  var mins = d.getMinutes();
  // Pad mins to format "XX". e.g. 8 -> "08", 10 -> "10"
  var paddedMins = mins < 10 ? "0" + mins : mins;
  return [
    d.getDate(),
    months[d.getMonth()],
    d.getFullYear(),
    d.getHours() + ":" + paddedMins,
  ].join(" ");
}

////////////////////////////////////////////////////////////

export const presentForum = function (forum) {
  if (!forum) return null;

  forum.url = "/forums/" + belt.slugify(forum.id, forum.title);

  presentForum(forum.parent_forum);
  presentForum(forum.child_forum);

  if (forum.mods) {
    forum.mods.forEach(presentUser);
  }
  if (forum.topics) {
    forum.topics.forEach(presentTopic);
  }
  if (forum.forums) {
    forum.forums.forEach(presentForum);
  }

  // For findForum2
  if (Array.isArray(forum.child_forums)) {
    forum.child_forums.forEach(presentForum);
  }
  if (Array.isArray(forum.sibling_forums)) {
    forum.sibling_forums.forEach(presentForum);
  }

  presentPost(forum.latest_post);
  presentUser(forum.latest_user);

  return forum;
};

export type PresentedUser = DbUser & {
  url: string;
  avatar_url_sm: string;
};

export function presentUser(user: DbUser | void): PresentedUser | null {
  if (!user) return null;

  (user as PresentedUser).url = "/users/" + user.slug;

  delete (user as any).digest;

  if (user.is_nuked) {
    user.bio_markup = "";
    user.bio_html = "";
    user.sig_html = "";
    user.sig = "";
    user.avatar_url = "";
    user.custom_title = "";
  }

  presentUser(user.nuked_by);
  presentUser(user.approved_by);

  // Reminder: Only avatar uploads since the S3 bucket update will
  // be served from the avatars.roleplayeguild.com bucket,
  // so here we'll check for that and only write those to go through
  // our avatars subdomain
  if (user.avatar_url && URL.canParse(user.avatar_url)) {
    const parsed = new URL(user.avatar_url);
    if (parsed.pathname.startsWith("/avatars.roleplayerguild.com/")) {
      user.avatar_url = "https://" + parsed.pathname.slice(1);
    }

    (user as PresentedUser).avatar_url_sm = user.avatar_url.replace(
      /\/([a-f0-9\-]+\.[a-z]+)$/,
      "/32/$1",
    );
  }

  if (user.id === 1485) {
    user.posts_count += 30000;
  }

  // Fix embedded
  if (typeof user.created_at === "string")
    user.created_at = new Date(user.created_at);
  if (typeof user.last_online_at === "string")
    user.last_online_at = new Date(user.last_online_at);

  return user as PresentedUser;
}

export const presentTopic = function (topic) {
  if (!topic) return null;

  topic.url = "/topics/" + belt.slugify(topic.id, topic.title);

  // created_at will be string when embedded in query result via to_json
  if (_.isString(topic.created_at))
    topic.created_at = new Date(topic.created_at);

  // Subs
  topic.subscriptionUrl = "/me/subscriptions/" + topic.id;

  if (topic.posts) topic.posts.forEach(presentPost);
  presentForum(topic.forum);
  presentUser(topic.user);

  //// Check for cache props
  // Post caches
  presentPost(topic.latest_post);
  presentPost(topic.latest_ic_post);
  presentPost(topic.latest_ooc_post);
  presentPost(topic.latest_char_post);
  // User caches
  presentUser(topic.latest_user);
  presentUser(topic.latest_ic_user);
  presentUser(topic.latest_ooc_user);
  presentUser(topic.latest_char_user);

  return topic;
};

export const presentCategory = function (category) {
  if (!category) return null;

  if (category.forums) {
    category.forums.forEach(presentForum);
  }

  return category;
};

export type PresentedConvo = DbConvo & {
  url: string;
  created_at: Date;
  user?: PresentedUser;
  participants: DbUser[];
  pms: DbPm[];
};

export function presentConvo(convo: DbConvo): PresentedConvo | null {
  if (!convo) return null;

  if (_.isString(convo.created_at))
    convo.created_at = new Date(convo.created_at);

  convo.url = "/convos/" + convo.id;

  presentUser(convo.user);
  if (convo.participants) convo.participants.forEach(presentUser);
  if (convo.pms) convo.pms.forEach(presentPm);
  presentUser(convo.latest_user);
  presentPm(convo.latest_pm);

  return convo as PresentedConvo;
}

export const presentPost = function (post) {
  if (!post) return null;

  if (typeof post.created_at === "string")
    post.created_at = new Date(post.created_at);
  // updated_at is null if post hasn't been edited
  if (typeof post.updated_at === "string")
    post.updated_at = new Date(post.updated_at);
  if (post.updated_at) post.formattedUpdatedAt = formatDate(post.updated_at);
  post.url = "/posts/" + post.id;
  presentUser(post.user);
  presentTopic(post.topic);
  presentForum(post.forum);
  return post;
};

export const presentPm = function (pm) {
  if (!pm) return null;
  if (_.isString(pm.created_at)) pm.created_at = new Date(pm.created_at);
  pm.formattedCreatedAt = formatDate(pm.created_at);
  pm.url = "/pms/" + pm.id;

  presentUser(pm.user);
  presentConvo(pm.convo);

  return pm;
};

export const presentNotification = function (n) {
  if (!n) return null;

  presentTopic(n.topic);
  presentConvo(n.convo);
  presentPost(n.post);

  return n;
};

////////////////////////////////////////////////////////////

export const presentStatus = function (x) {
  if (!x) return null;

  presentUser(x.user);

  return x;
};

export const presentTrophy = function (t) {
  if (!t) return null;

  t.url = "/trophies/" + t.id;

  // awarded_by is normally a user_id, but it should be SELECT'd
  // as a json object of the user that awarded the trophy
  presentUser(t.awarded_by);

  if (t.winners) t.winners.forEach(presentUser);

  return t;
};

////////////////////////////////////////////////////////////

export const presentFriendship = function (f) {
  if (!f) return null;

  presentUser(f.to_user);

  return f;
};

export const presentVm = function (vm) {
  if (!vm) return null;

  vm.url = `/vms/${vm.id}`;

  // Fix embedded

  if (_.isString(vm.created_at)) {
    vm.created_at = new Date(vm.created_at);
  }

  presentUser(vm.from_user);
  presentUser(vm.to_user);

  if (vm.child_vms) {
    vm.child_vms.forEach(presentVm);
  }

  return vm;
};

////////////////////////////////////////////////////////////

export const presentKeyval = function (x) {
  if (!x) return null;

  presentUser(x.updated_by);

  return x;
};

////////////////////////////////////////////////////////////

export const presentImage = function (x) {
  if (!x) return null;

  presentUser(x.user);

  // Set the URL for viewing individual images
  if (x.user) {
    x.url = `/users/${x.user.slug}/images/${x.id}`;
  }

  // Legacy image url: https://s3.amazonaws.com/img.roleplayerguild.com/prod/users/0001999e-ac95-468b-a526-0fd8ffc8591b.png
  // New image url: https://img.roleplayerguild.com/prod/users/0001999e-ac95-468b-a526-0fd8ffc8591b.avif

  const url = new URL(x.src);
  if (url.hostname === "s3.amazonaws.com") {
    // Legacy image url needs to be transformed
    x.src = "https://" + url.pathname.slice(1);
  } else {
    // New url is already correct
    x.src = url.toString();
  }

  return x;
};

export const presentAlbum = function (x) {
  if (!x) return null;
  presentUser(x.user);
  x.url = `/albums/${x.id}`;
  return x;
};

// DICE

export const presentCampaign = function (x) {
  if (!x) return null;
  presentUser(x.user);
  presentRoll(x.last_roll);
  x.url = `/campaigns/${x.id}`;
  return x;
};

export const presentRoll = function (x) {
  if (!x) return null;
  presentUser(x.user);
  presentCampaign(x.campaign);
  x.absoluteUrl = `${config.HOST}/rolls/${x.id}`;
  x.url = `/rolls/${x.id}`;
  return x;
};

export const presentTag = function (x) {
  if (!x) return null;

  if (typeof x.created_at === "string") {
    x.created_at = new Date(x.created_at);
  }

  x.url = `/tags/${x.id}`;

  return x;
};

export const presentTagGroup = function (x) {
  if (!x) return null;

  if (x.tags) {
    x.tags.forEach(presentTag);
  }

  x.url = `/tag-groups/${x.id}`;

  return x;
};

export const presentTopicBan = function (x) {
  if (!x) return null;

  x.url = `/topic-bans/${x.id}`;

  presentUser(x.banned);
  presentUser(x.banned_by);

  return x;
};

export const presentPostRev = function (x) {
  if (!x) return null;

  x.url = `/posts/${x.post_id}/revisions/${x.id}`;

  presentUser(x.user);

  return x;
};

export const presentUnameChange = function (x) {
  if (!x) return null;

  presentUser(x.user);
  presentUser(x.changed_by);

  return x;
};
