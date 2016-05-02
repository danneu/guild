"use strict";
// Node
var util = require('util');
var nodeUrl = require('url');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:presenters');
// 1st party
var belt = require('./belt');
var config = require('./config');

// Util ////////////////////////////////////////////////////

// Ex: formatDate(d) -> '8 Dec 2014 16:24'
exports.formatDate = formatDate;
function formatDate(d) {

  // HACK: Help me realize when I call formatDate when there is no date in dev
  if (config.NODE_ENV === 'development' && !d) {
    return '[DATE WAS UNDEFINED]';
  }

  var months = ["Jan", "Feb", "Mar", "Apr",
                "May", "Jun", "Jul", "Aug",
                "Sep", "Oct", "Nov", "Dec"];
  var mins = d.getMinutes();
  // Pad mins to format "XX". e.g. 8 -> "08", 10 -> "10"
  var paddedMins = mins < 10 ? '0' + mins : mins;
  return [
    d.getDate(),
    months[d.getMonth()],
    d.getFullYear(),
    d.getHours() + ':' + paddedMins
  ].join(' ');
}

// Number -> String
// Ex: numWithCommas(10000) => '10,000'
function numWithCommas(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

////////////////////////////////////////////////////////////

exports.presentForum = presentForum;
function presentForum(forum) {
  forum.url = '/forums/' + belt.slugify(forum.id, forum.title);

  if (forum.parent_forum)
    forum.parent_forum = presentForum(forum.parent_forum);
  if (forum.child_forum)
    forum.child_forum = presentForum(forum.child_forum);

  if (forum.topics)
    forum.topics = forum.topics.map(presentTopic);
  if (forum.latest_post)
    forum.latest_post = presentPost(forum.latest_post);
  if (forum.latest_user)
    forum.latest_user = presentUser(forum.latest_user);
  if (forum.forums)
    forum.forums = forum.forums.map(presentForum);

  return forum;
}

exports.presentUser = presentUser;
function presentUser(user) {
  if (!user) return user;
  user.url = '/users/' + user.slug;

  // Reminder: Only avatar uploads since the S3 bucket update will
  // be served from the avatars.roleplayeguild.com bucket,
  // so here we'll check for that and only write those to go through
  // our avatars subdomain
  if (user.avatar_url) {
    const parsed = nodeUrl.parse(user.avatar_url);
    if (parsed.pathname.startsWith('/avatars.roleplayerguild.com/')) {
      user.avatar_url = 'https://' + parsed.pathname.slice(1);
    }
  }

  // Fix embedded
  if (_.isString(user.created_at))
    user.created_at = new Date(user.created_at);
  if (_.isString(user.last_online_at))
    user.last_online_at = new Date(user.last_online_at);

  return user;
}

exports.presentTopic = presentTopic;
function presentTopic(topic) {
  topic.url = '/topics/' + belt.slugify(topic.id, topic.title);

  // created_at will be string when embedded in query result via to_json
  if (_.isString(topic.created_at))
    topic.created_at = new Date(topic.created_at);

  // Subs
  topic.subscriptionUrl = '/me/subscriptions/' + topic.id;

  if (topic.posts)
    topic.posts = topic.posts.map(presentPost);
  if (topic.forum)
    topic.forum = presentForum(topic.forum);
  if (topic.user)
    topic.user = presentUser(topic.user);

  //// Check for cache props
  // Post caches
  if (topic.latest_post)
    topic.latest_post = presentPost(topic.latest_post);
  if (topic.latest_ic_post)
    topic.latest_ic_post = presentPost(topic.latest_ic_post);
  if (topic.latest_ooc_post)
    topic.latest_ooc_post = presentPost(topic.latest_ooc_post);
  if (topic.latest_char_post)
    topic.latest_char_post = presentPost(topic.latest_char_post);
  // User caches
  if (topic.latest_user)
    topic.latest_user = presentUser(topic.latest_user);
  if (topic.latest_ic_user)
    topic.latest_ic_user = presentUser(topic.latest_ic_user);
  if (topic.latest_ooc_user)
    topic.latest_ooc_user = presentUser(topic.latest_ooc_user);
  if (topic.latest_char_user)
    topic.latest_char_user = presentUser(topic.latest_char_user);

  return topic;
}

exports.presentCategory = function(category) {
  if (category.forums)
    category.forums = category.forums.map(presentForum);
  return category;
};

exports.presentConvo = presentConvo;
function presentConvo(convo) {
  if (_.isString(convo.created_at))
    convo.created_at = new Date(convo.created_at);
  convo.url = '/convos/' + convo.id;
  if (convo.user)
    convo.user = presentUser(convo.user);
  if (convo.participants)
    convo.participants = convo.participants.map(presentUser);
  if (convo.pms)
    convo.pms = convo.pms.map(presentPm);
  if (convo.latest_user)
    convo.latest_user = presentUser(convo.latest_user);
  if (convo.latest_pm)
    convo.latest_pm = presentPm(convo.latest_pm);
  return convo;
}

exports.presentPost = presentPost;
function presentPost(post) {
  if (_.isString(post.created_at))
    post.created_at = new Date(post.created_at);
  // updated_at is null if post hasn't been edited
  if (_.isString(post.updated_at))
    post.updated_at = new Date(post.updated_at);
  if (post.updated_at)
    post.formattedUpdatedAt = formatDate(post.updated_at);
  post.url = '/posts/' + post.id;
  if (post.user)
    post.user = presentUser(post.user);
  if (post.topic)
    post.topic = presentTopic(post.topic);
  if (post.forum)
    post.forum = presentForum(post.forum);
  return post;
}

exports.presentPm = presentPm;
function presentPm(pm) {
  if (_.isString(pm.created_at))
    pm.created_at = new Date(pm.created_at);
  pm.formattedCreatedAt = formatDate(pm.created_at);
  pm.url = '/pms/' + pm.id;
  if (pm.user)
    pm.user = presentUser(pm.user);
  if (pm.convo)
    pm.convo = presentConvo(pm.convo);
  return pm;
}

exports.presentNotification = function(n) {
  if (n.topic)
    n.topic = exports.presentTopic(n.topic);
  if (n.convo)
    n.convo = exports.presentConvo(n.convo);
  if (n.post)
    n.post = exports.presentPost(n.post);

  return n;
};

////////////////////////////////////////////////////////////

exports.presentStatus = function(x) {
  if (!x) return x;
  exports.presentUser(x.user);
  return x;
};

exports.presentTrophy = function(t) {
  t.url = '/trophies/' + t.id;

  // awarded_by is normally a user_id, but it should be SELECT'd
  // as a json object of the user that awarded the trophy
  if (t.awarded_by)
    t.awarded_by = exports.presentUser(t.awarded_by);

  if (t.winners)
    t.winners = t.winners.map(exports.presentUser);

  return t;
};

exports.presentArenaOutcome = function(o) {
  if (o.user)
    o.user = exports.presentUser(o.user);

  return o;
};

exports.presentFriendship = function(f) {
  if (f.to_user)
    f.to_user = exports.presentUser(f.to_user);

  return f;
};

exports.presentVm = function(vm) {
  // Fix embedded
  if (_.isString(vm.created_at)) {
    vm.created_at = new Date(vm.created_at);
  }

  if (vm.from_user) {
    vm.from_user = exports.presentUser(vm.from_user);
  }
  if (vm.child_vms) {
    vm.child_vms = vm.child_vms.map(exports.presentVm);
  }

  return vm;
};

exports.presentKeyval = function (x) {
  if (!x) return x;
  exports.presentUser(x.updated_by);
  return x;
};

exports.presentImage = function (x) {
  if (!x) return x;
  exports.presentUser(x.user);
  const ext = (function () {
    switch (x.mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/png': return 'png';
    }
  })();
  x.url = x.user.url + `/images/${x.id}`;
  x.src = 'https://' + nodeUrl.parse(x.src).pathname.slice(1)
  return x;
};

exports.presentAlbum = function (x) {
  if (!x) return x;
  exports.presentUser(x.user);
  x.url = `/albums/${x.id}`;
  return x;
};

// DICE

exports.presentCampaign = function (x) {
  debug(x);
  if (!x) return x;
  exports.presentUser(x.user);
  exports.presentRoll(x.last_roll);
  x.url = `/campaigns/${x.id}`;
  return x;
};

exports.presentRoll = function (x) {
  if (!x) return x;
  exports.presentUser(x.user);
  exports.presentCampaign(x.campaign);
  x.absoluteUrl = `${config.HOST}/rolls/${x.id}`;
  x.url = `/rolls/${x.id}`;
  return x;
};
