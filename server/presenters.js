// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:presenters');

// Util ////////////////////////////////////////////////////

// Ex: formatDate(d) -> '8 Dec 2014 16:24'
exports.formatDate = formatDate;
function formatDate(d) {
  var months = ["Jan", "Feb", "Mar", "Apr",
                "May", "Jun", "Jul", "Aug",
                "Sep", "Oct", "Nov", "Dec"];
  console.log(typeof d);
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
  forum.url = '/forums/' + forum.id;

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
  user.url = '/users/' + user.id;
  return user;
}

exports.presentTopic = presentTopic;
function presentTopic(topic) {
  topic.url = '/forums/' + topic.forum_id + '/topics/' + topic.id;

  if (topic.posts)
    topic.posts = topic.posts.map(presentPost);
  if (topic.forum)
    topic.forum = presentForum(topic.forum);
  if (topic.user)
    topic.user = presentUser(topic.user);
  if (topic.latest_post)
    topic.latest_post = presentPost(topic.latest_post);
  if (topic.latest_user)
    topic.latest_user = presentUser(topic.latest_user);

  return topic;
}

exports.presentConvo = presentConvo;
function presentConvo(convo) {
  convo.formattedCreatedAt = formatDate(convo.created_at);
  convo.url = '/convos/' + convo.id;
  convo.user = presentUser(convo.user);
  convo.participants = convo.participants.map(presentUser);
  return convo;
}

exports.presentPost = presentPost;
function presentPost(post) {
  if (_.isString(post.created_at))
    post.created_at = new Date(post.created_at);
  post.formattedCreatedAt = formatDate(post.created_at);
  post.url = '/posts/' + post.id;
  if (post.user)
    post.user = presentUser(post.user);
  if (post.topic)
    post.topic = presentTopic(post.topic);
  return post;
}

exports.presentPm = presentPm;
function presentPm(pm) {
  if (_.isString(pm.created_at))
    pm.created_at = new Date(pm.created_at);
  pm.formattedCreatedAt = formatDate(pm.created_at);
  pm.url = '/posts/' + pm.id;
  if (pm.user)
    pm.user = presentUser(pm.user);
  if (pm.convo)
    pm.convo = presentConvo(pm.convo);
  return pm;
}
