// Node deps
var path = require('path');
var fs = require('co-fs');
var util = require('util');
// 3rd party
var pg = require('co-pg')(require('pg'));
var m = require('multiline');
var _ = require('lodash');
var assert = require('better-assert');
var debug = require('debug')('app:db');
// 1st party
var config = require('./config');
var belt = require('./belt');

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
  try {
    var result = yield client.queryPromise(sql, params);
    done();  // Release client back to pool
    return result;
  } catch(ex) {
    // Passing truthy value removes (instead of releases) conn
    done(ex);
    throw ex;
  }
}

exports.updateTopicStatus = function*(topicId, status) {
  var STATUS_WHITELIST = ['stick', 'unstick', 'hide', 'unhide', 'close', 'open'];
  assert(_.contains(STATUS_WHITELIST, status));
  var sql = m(function() {/*
UPDATE topics
SET is_sticky = COALESCE($2, is_sticky),
    is_hidden = COALESCE($3, is_hidden),
    is_closed = COALESCE($4, is_closed)
WHERE id = $1
RETURNING *
  */});
  var params;
  switch(status) {
    case 'stick':   params = [true,  null,  null]; break;
    case 'unstick': params = [false, null,  null]; break;
    case 'hide':    params = [null,  true,  null]; break;
    case 'unhide':  params = [null,  false, null]; break;
    case 'close':   params = [null,  null,  true]; break;
    case 'open':    params = [null,  null,  false]; break;
    default: throw new Error('Invalid status ' + status);
  }
  var result = yield query(sql, [topicId].concat(params));
  return result.rows[0];
};

exports.subscribeToTopic = function*(userId, topicId) {
  var sql = m(function() {/*
INSERT INTO topic_subscriptions (user_id, topic_id)
VALUES ($1, $2)
  */});
  try {
  var result = yield query(sql, [userId, topicId]);
  } catch(ex) {
    if (ex.code === '23505')
      return;
    throw ex;
  }
};

exports.unsubscribeFromTopic = function*(userId, topicId) {
  var sql = m(function() {/*
DELETE FROM topic_subscriptions
WHERE user_id = $1 AND topic_id = $2
  */});
  var result = yield query(sql, [userId, topicId]);
  return;
};

// Same as findTopic but takes a userid so that it can return a topic
// with an is_subscribed boolean for the user
exports.findTopicWithIsSubscribed = function* (userId, topicId) {
  var sql = m(function() {/*
SELECT
  t.*,
  to_json(f.*) "forum",
  array_agg($1::int) @> Array[ts.user_id::int] "is_subscribed"
FROM topics t
JOIN forums f ON t.forum_id = f.id
LEFT OUTER JOIN topic_subscriptions ts ON t.id = ts.topic_id
WHERE t.id = $2
GROUP BY t.id, f.id, ts.user_id
  */});
  var result = yield query(sql, [userId, topicId]);
  return result.rows[0];
};

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

exports.createResetToken = function*(userId) {
  debug('[createResetToken] userId: ' + userId);
  var uuid = belt.generateUuid();
  var sql = m(function() {/*
INSERT INTO reset_tokens (user_id, token)
VALUES ($1, $2)
RETURNING *
  */});
  var result = yield query(sql, [userId, uuid]);
  return result.rows[0];
};

// Note: Case-insensitive
exports.findUserByEmail = findUserByEmail;
function *findUserByEmail(email) {
  debug('[findUserByEmail] email: ' + email);
  var sql = m(function() {/*
SELECT *
FROM users u
WHERE lower(u.email) = lower($1);
  */});
  var result = yield query(sql, [email]);
  return result.rows[0];
}

// Note: Case-insensitive
exports.findUserByUname = findUserByUname;
function *findUserByUname(uname) {
  debug('[findUserByUname] uname: ' + uname);
  var sql = m(function() {/*
SELECT *
FROM users u
WHERE lower(u.uname) = lower($1);
  */});
  var result = yield query(sql, [uname]);
  return result.rows[0];
}

exports.findRecentPostsForUserId = findRecentPostsForUserId;
function* findRecentPostsForUserId(userId) {
  var sql = m(function() {/*
SELECT
  p.*,
  to_json(t.*) "topic"
FROM posts p
JOIN topics t ON p.topic_id = t.id
WHERE p.user_id = $1
LIMIT 25
  */});
  var result = yield query(sql, [userId]);
  return result.rows;
}

exports.findUser = findUser;
function *findUser(userId) {
  debug('[findUser] userId: ' + userId);
  var sql = m(function() {/*
SELECT *
FROM users
WHERE id = $1
  */});
  var result = yield query(sql, [userId]);
  return result.rows[0];
}

exports.findUsersByUnames = function*(unames) {
  assert(_.isArray(unames));
  assert(_.every(unames, _.isString));
  var sql = m(function() {/*
SELECT u.*
FROM users u
WHERE u.uname = ANY ($1::text[])
  */});
  var result = yield query(sql, [unames]);
  return result.rows;
};

// If toUsrIds is not given, then it's a self-convo
// TODO: Wrap in transaction, Document the args of this fn
exports.createConvo = function*(args) {
  debug('[createConvo] args: ' + util.inspect(args));
  assert(_.isNumber(args.userId));
  assert(_.isUndefined(args.toUserIds) || _.isArray(args.toUserIds));
  assert(_.isString(args.title));
  assert(_.isString(args.text));
  var convoSql = m(function() {/*
INSERT INTO convos (user_id, title)
VALUES ($1, $2)
RETURNING *
  */});
  var pmSql = m(function() {/*
INSERT INTO pms (user_id, convo_id, text, ip_address)
VALUES ($1, $2, $3, $4)
RETURNING *
*/});
  var participantSql = m(function() {/*
INSERT INTO convos_participants (user_id, convo_id)
VALUES ($1, $2)
*/});
  var convo = (yield query(convoSql, [args.userId, args.title])).rows[0];

  debug(convo);
  // Run these in parallel
  yield args.toUserIds.map(function(toUserId) {
    return query(participantSql, [toUserId, convo.id]);
  }).concat([
    query(participantSql, [args.userId, convo.id]),
    query(pmSql, [args.userId, convo.id, args.text, args.ipAddress])
  ]);

  convo.pms_count++;  // This is a stale copy so we need to manually inc
  return convo;
};

// Only returns user if reset token has not expired
// so this can be used to verify tokens
exports.findUserByResetToken = function*(resetToken) {
  assert(belt.isValidUuid(resetToken));

  // Short circuit if it's not even a UUID
  if (!belt.isValidUuid(resetToken))
    return;

  var sql = m(function() {/*
SELECT *
FROM users u
WHERE u.id = (
  SELECT rt.user_id
  FROM active_reset_tokens rt
  WHERE rt.token = $1
)
  */});
  var result = yield query(sql, [resetToken]);
  return result.rows[0];
}

exports.findUserBySessionId = findUserBySessionId;
function *findUserBySessionId(sessionId) {
  assert(belt.isValidUuid(sessionId));
  var sql = m(function() {/*
SELECT *
FROM users u
WHERE u.id = (
  SELECT s.user_id
  FROM active_sessions s
  WHERE s.id = $1
)
  */});
  return (yield query(sql, [sessionId])).rows[0];
}

exports.createSession = createSession;
function *createSession(props) {
  debug('[createSession] props: ' + util.inspect(props));
  assert(_.isNumber(props.userId));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.interval));
  var uuid = belt.generateUuid();
  var sql = m(function () {/*
INSERT INTO sessions (user_id, id, ip_address, expired_at)
VALUES ($1, $2, $3::inet, NOW() + $4::interval)
RETURNING *
  */});
  return (yield query(sql, [
    props.userId, uuid, props.ipAddress, props.interval
  ])).rows[0];
};

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

exports.updateUserPassword = function*(userId, password) {
  assert(_.isNumber(userId));
  assert(_.isString(password));
  var digest = yield belt.hashPassword(password);
  var sql = m(function() {/*
UPDATE users
SET digest = $2
WHERE id = $1
RETURNING *
  */});
  var result = yield query(sql, [userId, digest]);
  return result.rows[0];
};

// Keep updatePost and UpdatePm in sync
exports.updatePost = function*(postId, text) {
  assert(_.isString(text));
  var sql = m(function() {/*
UPDATE posts
SET text = $2, updated_at = NOW()
WHERE id = $1
RETURNING *
  */});
  var result = yield query(sql, [postId, text]);
  return result.rows[0];
};
exports.updatePm = function*(id, text) {
  assert(_.isString(text));
  var sql = m(function() {/*
UPDATE pms
SET text = $2, updated_at = NOW()
WHERE id = $1
RETURNING *
  */});
  var result = yield query(sql, [id, text]);
  return result.rows[0];
};

// Attaches topic and forum to post for authorization checks
// See cancan.js 'READ_POST'
exports.findPostWithTopicAndForum = function*(postId) {
  var sql = m(function() {/*
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum"
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.id = $1
  */});
  var result = yield query(sql, [postId]);
  return result.rows[0];
};

// Keep findPost and findPm in sync
exports.findPost = function*(postId) {
  var sql = m(function() {/*
SELECT *
FROM posts
WHERE id = $1
  */});
  var result = yield query(sql, [postId]);
  return result.rows[0];
};
exports.findPm = function*(id) {
  var sql = m(function() {/*
SELECT *
FROM pms
WHERE id = $1
  */});
  var result = yield query(sql, [id]);
  return result.rows[0];
};

// TODO: Sort by latest_pm_at
exports.findConvosInvolvingUserId = function*(userId) {
  var sql = m(function() {/*
SELECT
  c.*,
  to_json(u1.*) "user",
  to_json(array_agg(u2.*)) "participants"
FROM convos c
JOIN convos_participants cp ON c.id = cp.convo_id
JOIN users u1 ON c.user_id = u1.id
JOIN users u2 ON cp.user_id = u2.id
WHERE c.id IN (
  SELECT cp.convo_id
  FROM convos_participants cp
  WHERE cp.user_id = $1
)
GROUP BY c.id, u1.id
  */});
  var result = yield query(sql, [userId]);
  return result.rows;
};

exports.findConvo = function*(convoId) {
  assert(!_.isUndefined(convoId));
  var sql = m(function() {/*
SELECT
  c.*,
  to_json(u1.*) "user",
  to_json(array_agg(u2.*)) "participants"
FROM convos c
JOIN convos_participants cp ON c.id = cp.convo_id
JOIN users u1 ON c.user_id = u1.id
JOIN users u2 ON cp.user_id = u2.id
WHERE c.id = $1
GROUP BY c.id, u1.id
  */});
  var result = yield query(sql, [convoId]);
  return result.rows[0];
};

exports.findPmsByConvoId = function*(convoId) {
  var sql = m(function() {/*
SELECT
  pms.*,
  to_json(u.*) "user"
FROM pms
JOIN users u ON pms.user_id = u.id
WHERE pms.convo_id = $1
GROUP BY pms.id, u.id
ORDER BY pms.id
  */});
  var result = yield query(sql, [convoId]);
  return result.rows;
};

exports.findPostsByTopicId = function*(topicId, postType) {
  var sql = m(function() {/*
SELECT
  p.*,
  to_json(u.*) "user"
FROM posts p
JOIN users u ON p.user_id = u.id
WHERE p.topic_id = $1 AND p.type = $2
GROUP BY p.id, u.id
ORDER BY p.id
  */});
  var result = yield query(sql, [topicId, postType]);
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

// Keep findPostWithTopic and findPmWithConvo in sync
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

// Keep findPostWithTopic and findPmWithConvo in sync
exports.findPmWithConvo = function*(pmId) {
  var sql = m(function() {/*
SELECT
  pms.*,
  to_json(c.*) "convo"
FROM pms
JOIN convos c ON pms.convo_id = c.id
WHERE pms.id = $1
GROUP BY pms.id, c.id
  */});
  var result = yield query(sql, [pmId]);
  return result.rows[0];
};

// Returns created PM
exports.createPm = function*(props) {
  assert(_.isNumber(props.userId));
  assert(props.convoId);
  assert(_.isString(props.text));
  var sql = m(function() {/*
INSERT INTO pms (user_id, ip_address, convo_id, text)
VALUES ($1, $2::inet, $3, $4)
RETURNING *
  */});
  var result = yield query(sql, [
    props.userId,
    props.ipAddress,
    props.convoId,
    props.text
  ]);
  return result.rows[0];
};

// Args:
// - userId      Required Number/String
// - ipAddress   Optional String
// - text        Required String
// - topicId     Required Number/String
// - type        Required String, ic | ooc | char
// - isRoleplay  Required Boolean
exports.createPost = function*(args) {
  assert(_.isNumber(args.userId));
  assert(_.isString(args.ipAddress));
  assert(_.isString(args.text));
  assert(args.topicId);
  assert(_.isBoolean(args.isRoleplay));
  assert(_.contains(['ic', 'ooc', 'char'], args.type));
  var sql = m(function() {/*
INSERT INTO posts (user_id, ip_address, topic_id, text, type, is_roleplay)
VALUES ($1, $2::inet, $3, $4, $5, $6)
RETURNING *
  */});
  var result = yield query(sql, [args.userId, args.ipAddress, args.topicId, args.text, args.type, args.isRoleplay]);
  return result.rows[0];
};

// TODO: Wrap in txn abstraction
// Args:
// - userId     Required Number/String
// - forumId    Required Number/String
// - ipAddress  Optional String
// - title      Required String
// - text       Required String
// - postType   Required String, ic | ooc | char
// - isRoleplay Required Boolean
//
exports.createTopic = function*(props) {
  assert(_.isNumber(props.userId));
  assert(props.forumId);
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.title));
  assert(_.isString(props.text));
  assert(_.isBoolean(props.isRoleplay));
  assert(_.contains(['ic', 'ooc', 'char'], props.postType));
  var topicSql = m(function() {/*
INSERT INTO topics (forum_id, user_id, title, is_roleplay)
VALUES ($1, $2, $3, $4)
RETURNING *
  */});
  var postSql = m(function() {/*
INSERT INTO posts (topic_id, user_id, ip_address, text, type, is_roleplay)
VALUES ($1, $2, $3::inet, $4, $5, $6)
RETURNING *
  */});
  try {
    yield query('BEGIN');
    var topicResult = yield query(topicSql, [
      props.forumId, props.userId, props.title, props.isRoleplay
    ]);
    var topic = topicResult.rows[0];
    yield query(postSql, [topic.id, props.userId, props.ipAddress, props.text, props.postType, props.isRoleplay]);
    yield query('COMMIT');
  } catch(ex) {
    yield query('ROLLBACK');
    throw ex;
  }

  return topic;
};

exports.findForum = function*(forumId) {
  var sql = m(function() {/*
SELECT
  f.*,
  to_json(f2.*) "child_forum",
  to_json(f3.*) "parent_forum"
FROM forums f
LEFT OUTER JOIN forums f2 ON f.id = f2.parent_forum_id
LEFT OUTER JOIN forums f3 ON f.parent_forum_id = f3.id
WHERE f.id = $1
GROUP BY f.id, f2.id, f3.id
  */});
  var result = yield query(sql, [forumId]);
  return result.rows[0];
};

exports.findLatestUsers = function*(limit) {
  var sql = m(function() {/*
SELECT u.*
FROM users u
ORDER BY id DESC
LIMIT $1
  */});
  var result = yield query(sql, [limit || 25]);
  return result.rows;
};

// Also has cat.forums array
exports.findModCategory = function*() {
  var MOD_CATEGORY_ID = 6;
  var sql = m(function() {/*
SELECT c.*
FROM categories c
WHERE c.id = $1
  */});
  var result = yield query(sql, [MOD_CATEGORY_ID]);
  return result.rows[0];
};

// Only returns non-mod-forum categories
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

// Creates a user and a session (logs them in).
// - Returns {:user <User>, :session <Session>}
// - Use `createUser` if you only want to create a user.
exports.createUserWithSession = createUserWithSession;
function *createUserWithSession(props) {
  debug('[createUserWithSession] props: ' + util.inspect(props));
  assert(_.isString(props.uname));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.password));
  assert(_.isString(props.email));

  var digest = yield belt.hashPassword(props.password);
  var sql = m(function () {/*
INSERT INTO users (uname, digest, email)
VALUES ($1, $2, $3)
RETURNING *;
   */});
  var user = (yield query(sql, [props.uname, digest, props.email])).rows[0];
  var session = yield createSession({
    userId: user.id,
    ipAddress: props.ipAddress,
    interval: '1 year'  // TODO: Decide how long to log user in upon registration
  });
  return { user: user, session: session };
};

exports.logoutSession = logoutSession;
function *logoutSession(userId, sessionId) {
  assert(_.isNumber(userId));
  assert(_.isString(sessionId) && belt.isValidUuid(sessionId));
  var sql = m(function() {/*
DELETE FROM sessions
WHERE user_id = $1 AND id = $2
  */});
  return yield query(sql, [userId, sessionId]);
};

// Sort them by latest_posts first
exports.findSubscribedTopicsForUserId = function*(userId) {
  var sql = m(function() {/*
SELECT
  t.*,
  to_json(u.*)                "user",
  to_json(latest_post.*)      "latest_post",
  to_json(u2.*)               "latest_user",
  to_json(latest_ic_post.*)   "latest_ic_post",
  to_json(latest_ic_user.*)   "latest_ic_user",
  to_json(latest_ooc_post.*)  "latest_ooc_post",
  to_json(latest_ooc_user.*)  "latest_ooc_user",
  to_json(latest_char_post.*) "latest_char_post",
  to_json(latest_char_user.*) "latest_char_user",
  to_json(f.*)                "forum"
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
  */});
  var result = yield query(sql, [userId]);
  return result.rows;
};

exports.findForums = findForums;
function* findForums(categoryIds) {
  assert(_.isArray(categoryIds));
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
