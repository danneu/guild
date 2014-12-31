// Node deps
var path = require('path');
var fs = require('co-fs');
// 3rd party
var pg = require('co-pg')(require('pg'));
var m = require('multiline');
var _ = require('lodash');
var assert = require('better-assert');
// 1st party
var config = require('./config');

// parse int8 as an integer
// TODO: Handle numbers past parseInt range
pg.types.setTypeParser(20, function(val) {
    return val === null ? null : parseInt(val);
});

// TODO: Create query fn for transactions
exports.query = query;
function *query(sql, params) {
  var conn_result = yield pg.connectPromise(config.DATABASE_URL);
  var client = conn_result[0];
  var done = conn_result[1];
  var result = yield client.queryPromise(sql, params);
  done();  // Release client back to pool
  return result;
}

exports.findTopic = function* (topicId) {
  var sql = m(function() {/*
SELECT
  t.*,
  to_json(f.*) "forum"
FROM topics t
JOIN forums f ON t.forum_id = f.id
WHERE t.id = $1
  */});
  var result = yield query(sql, [topicId]);
  return result.rows[0];
};

// TODO: Order by
// TODO: Pagination
// exports.findTopicWithPosts = function* (topicId) {
//   var sql = m(function() {/*
// SELECT
//   t.*,
//   to_json(f.*) "forum",
//   to_json(array_agg(p.*)) "posts"
// FROM topics t
// JOIN posts p ON t.id = p.topic_id
// JOIN forums f ON t.forum_id = f.id
// WHERE topic_id = $1
// GROUP BY t.id, f.id
//   */});
//   var result = yield query(sql, [topicId]);
//   return result.rows[0];
// };

exports.findTopicsByForumId = function*(forumId) {
  var sql = m(function() {/*
SELECT
  t.*,
  to_json(u.*) "user",
  to_json(p.*) "latest_post",
  to_json(u2.*) "latest_user"
FROM topics t
JOIN users u ON t.user_id = u.id
LEFT JOIN posts p ON t.latest_post_id = p.id
LEFT JOIN users u2 ON p.user_id = u2.id
WHERE t.forum_id = $1
ORDER BY t.latest_post_id DESC
  */});
  var result = yield query(sql, [forumId]);
  return result.rows;
};

exports.updatePost = function*(userId, postId, text) {
  assert(_.isNumber(userId));
  assert(_.isString(text));
  var sql = m(function() {/*
UPDATE posts
SET text = $3
WHERE user_id = $1 AND id = $2
RETURNING *
  */});
  var result = yield query(sql, [userId, postId, text]);
  return result.rows[0];
};

exports.findPost = function*(postId) {
  var sql = m(function() {/*
SELECT *
FROM posts
WHERE id = $1
  */});
  var result = yield query(sql, [postId]);
  return result.rows[0];
};

exports.findPostsByTopicId = function*(topicId) {
  var sql = m(function() {/*
SELECT
  p.*,
  to_json(u.*) "user"
FROM posts p
JOIN users u ON p.user_id = u.id
WHERE p.topic_id = $1
GROUP BY p.id, u.id
ORDER BY p.id
  */});
  var result = yield query(sql, [topicId]);
  return result.rows;
};

// TODO: Order by
// TODO: Pagination
exports.findForumWithTopics = function* (forumId) {
  var sql = m(function() {/*
SELECT
  f.*,
  to_json(array_agg(t.*)) "topics",
  to_json(p.*) "latest_post"
FROM forums f
LEFT OUTER JOIN topics t ON f.id = t.forum_id
WHERE f.id = $1
GROUP BY f.id
  */});
  var result = yield query(sql, [forumId]);
  var forum = result.rows[0];
  if (!forum) return null;
  // The query will set forum.topics to `[null]` if it has
  // none, so compact it to just `[]`.
  forum.topics = _.compact(forum.topics);
  return forum;
};

exports.findPostWithTopic = function*(postId) {
  var sql = m(function() {/*
SELECT
  p.*,
  to_json(t.*) "topic"
FROM posts p
JOIN topics t ON p.topic_id = t.id
WHERE p.id = $1
GROUP BY p.id, t.id
  */});
  var result = yield query(sql, [postId]);
  return result.rows[0];
};

exports.createPost = function*(userId, ipAddress, topicId, text) {
  assert(_.isNumber(userId));
  assert(_.isString(ipAddress));
  assert(_.isString(text));
  var sql = m(function() {/*
INSERT INTO posts (user_id, ip_address, topic_id, text)
VALUES ($1, $2::inet, $3, $4)
RETURNING *
  */});
  var result = yield query(sql, [userId, ipAddress, topicId, text]);
  return result.rows[0];
};

// TODO: Wrap in txn abstraction
exports.createTopic = function*(props) {
  assert(_.isNumber(props.userId));
  assert(props.forumId);
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.title));
  assert(_.isString(props.text));
  var topicSql = m(function() {/*
INSERT INTO topics (forum_id, user_id, title)
VALUES ($1, $2, $3)
RETURNING *
  */});
  var postSql = m(function() {/*
INSERT INTO posts (topic_id, user_id, ip_address, text)
VALUES ($1, $2, $3::inet, $4)
RETURNING *
  */});
  try {
    yield query('BEGIN');
    var topicResult = yield query(topicSql, [
      props.forumId, props.userId, props.title
    ]);
    var topic = topicResult.rows[0];
    yield query(postSql, [topic.id, props.userId, props.ipAddress, props.text]);
    yield query('COMMIT');
  } catch(ex) {
    yield query('ROLLBACK');
    throw ex;
  }

  return topic;
};

exports.findForum = function*(forumId) {
  var sql = m(function() {/*
SELECT *
FROM forums
WHERE id = $1
  */});
  var result = yield query(sql, [forumId]);
  return result.rows[0];
};

exports.findCategories = function*() {
  var sql = m(function() {/*
SELECT c.*
FROM categories c
ORDER BY c.pos
  */});
  var result = yield query(sql);
  return result.rows;
};

// TODO: Order forums by pos
exports.findCategoriesWithForums = findCategoriesWithForums;
function* findCategoriesWithForums() {
  var sql = m(function() {/*
SELECT
  c.*,
  to_json(array_agg(f.*)) "forums"
FROM categories c
JOIN forums f ON c.id = f.category_id
GROUP BY c.id
ORDER BY c.pos
  */});
  var result = yield query(sql);
  return result.rows;
}

exports.findForums = findForums;
function* findForums(categoryIds) {
  assert(_.isArray(categoryIds));
  console.log('dd');
  var sql = m(function() {/*
SELECT
  f.*,
  to_json(p.*) "latest_post",
  to_json(t.*) "latest_topic",
  to_json(u.*) "latest_user"
FROM forums f
LEFT OUTER JOIN posts p ON f.latest_post_id = p.id
LEFT OUTER JOIN topics t ON t.id = p.topic_id
LEFT OUTER JOIN users u ON u.id = p.user_id
--WHERE f.category_id IN ($1)
WHERE f.category_id = ANY ($1::int[])
ORDER BY pos;
  */});
  var result = yield query(sql, [categoryIds]);
  return result.rows;
}
