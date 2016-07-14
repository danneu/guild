'use strict';
// 3rd
const assert = require('better-assert');
// 1st
const dbUtil = require('./util');

////////////////////////////////////////////////////////////

// Sort them by latest_posts first
exports.findSubscribedTopicsForUserId = function * (userId) {
  const sql = `
SELECT
  t.*,

  -- to_json(u.*)                "user",
  json_build_object(
    'uname', u.uname,
    'slug', u.slug
  ) "user",

  -- to_json(latest_post.*)      "latest_post",
  json_build_object(
    'id', latest_post.id,
    'created_at', latest_post.created_at
  ) "latest_post",

  -- to_json(u2.*)               "latest_user",
  json_build_object(
    'uname', u2.uname,
    'slug', u2.slug
  ) "latest_user",

  -- to_json(latest_ic_post.*)   "latest_ic_post",
  CASE
    WHEN latest_ic_post IS NULL THEN NULL
    ELSE
      json_build_object(
        'id', latest_ic_post.id,
        'created_at', latest_ic_post.created_at
      )
  END "latest_ic_post",

  -- to_json(latest_ic_user.*)   "latest_ic_user",
  CASE
    WHEN latest_ic_user IS NULL THEN NULL
    ELSE
      json_build_object(
        'uname', latest_ic_user.uname,
        'slug', latest_ic_user.slug
      )
  END "latest_ic_user",

  -- to_json(latest_ooc_post.*)  "latest_ooc_post",
  CASE
    WHEN latest_ooc_post IS NULL THEN NULL
    ELSE
      json_build_object(
        'id', latest_ooc_post.id,
        'created_at', latest_ooc_post.created_at
      )
  END "latest_ooc_post",

  -- to_json(latest_ooc_user.*)  "latest_ooc_user",
  CASE
    WHEN latest_ooc_user IS NULL THEN NULL
    ELSE
      json_build_object(
        'uname', latest_ooc_user.uname,
        'slug', latest_ooc_user.slug
      )
  END "latest_ooc_user",

  -- to_json(latest_char_post.*) "latest_char_post",
  CASE
    WHEN latest_char_post IS NULL THEN NULL
    ELSE
      json_build_object(
        'id', latest_char_post.id,
        'created_at', latest_char_post.created_at
      )
  END "latest_char_post",

  -- to_json(latest_char_user.*) "latest_char_user",
  CASE
    WHEN latest_char_user IS NULL THEN NULL
    ELSE
      json_build_object(
        'uname', latest_char_user.uname,
        'slug', latest_char_user.slug
      )
  END "latest_char_user",

  to_json(f.*) "forum"
FROM topic_subscriptions ts
JOIN topics t ON ts.topic_id = t.id
JOIN users u ON t.user_id = u.id
LEFT OUTER JOIN posts latest_post ON t.latest_post_id = latest_post.id
LEFT OUTER JOIN posts latest_ic_post ON t.latest_ic_post_id = latest_ic_post.id
LEFT OUTER JOIN users latest_ic_user ON latest_ic_post.user_id = latest_ic_user.id
LEFT OUTER JOIN posts latest_ooc_post ON t.latest_ooc_post_id = latest_ooc_post.id
LEFT OUTER JOIN users latest_ooc_user ON latest_ooc_post.user_id = latest_ooc_user.id
LEFT OUTER JOIN posts latest_char_post ON t.latest_char_post_id = latest_char_post.id
LEFT OUTER JOIN users latest_char_user ON latest_char_post.user_id = latest_char_user.id
JOIN users u2 ON latest_post.user_id = u2.id
JOIN forums f ON t.forum_id = f.id
WHERE ts.user_id = $1
ORDER BY t.latest_post_id DESC
  `;

  return yield dbUtil.queryMany(sql, [userId]);
};

////////////////////////////////////////////////////////////

// Do nothing if subscription already exists
exports.subscribeToTopic = function * (userId, topicId) {
  assert(userId);
  assert(topicId);
  return yield dbUtil.query(`
    INSERT INTO topic_subscriptions (user_id, topic_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, topic_id) DO NOTHING
  `, [userId, topicId]);
};

////////////////////////////////////////////////////////////

exports.unsubscribeFromTopic = function * (userId, topicId) {
  return yield dbUtil.query(`
DELETE FROM topic_subscriptions
WHERE user_id = $1 AND topic_id = $2
  `, [userId, topicId]);
};
