'use strict';
// 3rd
const Router = require('koa-router');
const _ = require('lodash');
// 1st
const cancan = require('../cancan');
const db = require('../db');
const pre = require('../presenters');
const belt = require('../belt');

////////////////////////////////////////////////////////////

const router = new Router();

////////////////////////////////////////////////////////////

//
// Show subscriptions
//
router.get('/me/subscriptions', function * () {
  this.assert(this.currUser, 404);
  const topics = yield db.subscriptions.findSubscribedTopicsForUserId(this.currUser.id);
  topics.forEach(pre.presentTopic);
  const grouped = _.groupBy(topics, (topic) => topic.forum.is_roleplay);
  const roleplayTopics = grouped[true] || [];
  const nonroleplayTopics = grouped[false] || [];
  yield this.render('subscriptions', {
    ctx: this,
    topics: topics,
    roleplayTopics: roleplayTopics,
    nonroleplayTopics: nonroleplayTopics,
    title: 'My Subscriptions'
  });
});

//
// Create subscription
//
// Body params:
// - topic-id
router.post('/me/subscriptions', function * () {
  this.assert(this.currUser, 404);

  // Ensure user doesn't have 200 subscriptions
  const subs = yield db.subscriptions.findSubscribedTopicsForUserId(this.currUser.id);
  if (subs.length >= 200) {
    this.body = 'You cannot have more than 200 topic subscriptions';
    return;
  }

  const topicId = this.request.body['topic-id'];
  this.assert(topicId, 404);
  const topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'SUBSCRIBE_TOPIC', topic);
  // TODO: flash
  yield db.subscriptions.subscribeToTopic(this.currUser.id, topicId);
  pre.presentTopic(topic);
  if (this.request.body['return-to-topic']) {
    return this.response.redirect(topic.url);
  }
  const redirectTo = this.query.redirectTo || '/me/subscriptions';
  this.response.redirect(redirectTo);
});

//
// Remove subcription
//
router.delete('/me/subscriptions/:topicSlug', function * () {
  const topicId = belt.extractId(this.params.topicSlug);
  this.assert(topicId, 404);
  this.assert(this.currUser, 404);
  const topic = yield db.findTopic(topicId);
  this.assertAuthorized(this.currUser, 'UNSUBSCRIBE_TOPIC', topic);
  yield db.subscriptions.unsubscribeFromTopic(this.currUser.id, topicId);
  // TODO: flash
  pre.presentTopic(topic);
  if (this.request.body['return-to-topic']) {
    return this.response.redirect(topic.url);
  }
  this.flash = { message: ['success', 'Successfully unsubscribed'] };
  const redirectTo = this.query.redirectTo || '/me/subscriptions';
  this.response.redirect(redirectTo);
});

////////////////////////////////////////////////////////////

module.exports = router;
