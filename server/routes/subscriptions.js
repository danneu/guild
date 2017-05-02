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
router.get('/me/subscriptions', async (ctx) => {
  ctx.assert(ctx.currUser, 404);
  const topics = await db.subscriptions.findSubscribedTopicsForUserId(ctx.currUser.id);
  topics.forEach(pre.presentTopic);
  const grouped = _.groupBy(topics, (topic) => topic.forum.is_roleplay);
  const roleplayTopics = grouped[true] || [];
  const nonroleplayTopics = grouped[false] || [];
  await ctx.render('subscriptions', {
    ctx,
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
router.post('/me/subscriptions', async (ctx) => {
  ctx.assert(ctx.currUser, 404);

  // Ensure user doesn't have 200 subscriptions
  const subs = await db.subscriptions.findSubscribedTopicsForUserId(ctx.currUser.id);
  if (subs.length >= 200) {
    ctx.body = 'You cannot have more than 200 topic subscriptions';
    return;
  }

  const topicId = ctx.request.body['topic-id'];
  ctx.assert(topicId, 404);
  const topic = await db.findTopic(topicId);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, 'SUBSCRIBE_TOPIC', topic);
  // TODO: flash
  await db.subscriptions.subscribeToTopic(ctx.currUser.id, topicId);
  pre.presentTopic(topic);
  if (ctx.request.body['return-to-topic']) {
    return ctx.response.redirect(topic.url);
  }
  const redirectTo = ctx.query.redirectTo || '/me/subscriptions';
  ctx.response.redirect(redirectTo);
});

//
// Remove subcription
//
router.delete('/me/subscriptions/:topicSlug', async (ctx) => {
  const topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  ctx.assert(ctx.currUser, 404);
  const topic = await db.findTopic(topicId);
  ctx.assertAuthorized(ctx.currUser, 'UNSUBSCRIBE_TOPIC', topic);
  await db.subscriptions.unsubscribeFromTopic(ctx.currUser.id, topicId);
  // TODO: flash
  pre.presentTopic(topic);
  if (ctx.request.body['return-to-topic']) {
    return ctx.response.redirect(topic.url);
  }
  ctx.flash = { message: ['success', 'Successfully unsubscribed'] };
  const redirectTo = ctx.query.redirectTo || '/me/subscriptions';
  ctx.response.redirect(redirectTo);
});

////////////////////////////////////////////////////////////

module.exports = router;
