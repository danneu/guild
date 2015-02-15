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
var coParallel = require('co-parallel');
// 1st party
var config = require('./config');
var belt = require('./belt');

// If a client is not provided to fn as first argument,
// we'll pass one into it.
function wrapOptionalClient(fn) {
  return function*() {
    var args = Array.prototype.slice.call(arguments, 0);
    if (belt.isDBClient(args[0])) {
      return yield fn.apply(null, args);
    } else {
      return yield withTransaction(function*(client) {
        return yield fn.apply(null, [client].concat(args));
      });
    }
  }
};

// Wraps generator function in one that prints out the execution time
// when app is run in development mode.
function wrapTimer(fn) {
  if (config.NODE_ENV !== 'development')
    return fn;
  else
    return function*() {
      var start = Date.now();
      var result = yield fn.apply(this, arguments);
      var diff = Date.now() - start;
      debug('[%s] Executed in %sms', fn.name, diff);
      return result;
    };
}

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

// `runner` is a function that takes the pg client as an argument.
//
// Ex:
//   return yield withTransaction(function*(client) {
//     var result = yield [
//       client.queryPromise(fromUpdateSql, [amount, fromAccountId]),
//       client.queryPromise(toUpdateSql,   [amount, toAccountId])
//     ];
//     var updatedFromAccount = result[0].rows[0];
//     var updatedToAccount   = result[1].rows[0];
//     return { fromAccount: updatedFromAccount, toAccount: updatedToAccount };
//   });
//
function* withTransaction(runner) {
  var connResult = yield pg.connectPromise(config.DATABASE_URL);
  var client = connResult[0];
  var done = connResult[1];

  try {
    yield client.queryPromise('BEGIN');
    var result = yield runner(client);
    yield client.queryPromise('COMMIT');
    done();

    return result;
  } catch(ex) {
    try {
      yield client.queryPromise('ROLLBACK');
      done();  // Release the rolled back conn
    } catch(ex) {
      done(ex);  // Kill the botched conn
    }

    throw ex;
  }
}

exports.updatePostStatus = function*(postId, status) {
  var STATUS_WHITELIST = ['hide', 'unhide'];
  assert(_.contains(STATUS_WHITELIST, status));
  var sql = m(function() {/*
UPDATE posts
SET is_hidden = $2
WHERE id = $1
RETURNING *
  */});
  var params;
  switch(status) {
    case 'hide':
      params = [postId, true];
      break;
    case 'unhide':
      params = [postId, false];
      break;
    default: throw new Error('Invalid status ' + status);
  }
  var result = yield query(sql, params);
  return result.rows[0];
};

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
exports.findTopicWithIsSubscribed = wrapTimer(findTopicWithIsSubscribed);
function* findTopicWithIsSubscribed(userId, topicId) {
  var sql = m(function() {/*
SELECT
  t.*,
  to_json(f.*) "forum",
  array_agg($1::int) @> Array[ts.user_id::int] "is_subscribed"
FROM topics t
JOIN forums f ON t.forum_id = f.id
LEFT OUTER JOIN topic_subscriptions ts
  ON t.id = ts.topic_id AND ts.user_id = $1
WHERE t.id = $2
GROUP BY t.id, f.id, ts.user_id
  */});
  var result = yield query(sql, [userId, topicId]);
  return result.rows[0];
};

exports.updateUserBio = function*(userId, bioMarkup, bioHtml) {
  assert(_.isString(bioMarkup));
  var sql = m(function() {/*
    UPDATE users
    SET bio_markup = $2, bio_html = $3
    WHERE id = $1
    RETURNING *
  */});
  var result = yield query(sql, [userId, bioMarkup, bioHtml]);
  return result.rows[0];
};

exports.findTopic = wrapTimer(findTopic);
function* findTopic(topicId) {
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

exports.deleteResetTokens = function*(userId) {
  assert(_.isNumber(userId));
  var sql = m(function() {/*
DELETE FROM reset_tokens
WHERE user_id = $1
  */});
  yield query(sql, [userId]);
};

exports.findLatestActiveResetToken = function*(userId) {
  assert(_.isNumber(userId));
  var sql = m(function() {/*
SELECT *
FROM active_reset_tokens
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 1
  */});
  var result = yield query(sql, [userId]);
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

exports.findUserById = exports.findUser = function*(id) {
  var sql = 'SELECT * FROM users WHERE id = $1';
  var result = yield query(sql, [id]);
  return result.rows[0];
};

exports.findUserBySlug = function*(slug) {
  assert(_.isString(slug));
  var sql = m(function() {/*
SELECT *
FROM users u
WHERE lower(u.slug) = lower($1)
  */});
  var result = yield query(sql, [slug]);
  return result.rows[0];
};

exports.findUserByUnameOrEmail = wrapTimer(findUserByUnameOrEmail);
function *findUserByUnameOrEmail(unameOrEmail) {
  assert(_.isString(unameOrEmail));
  var sql = m(function() {/*
SELECT *
FROM users u
WHERE lower(u.uname) = lower($1) OR lower(u.email) = lower($1);
  */});
  var result = yield query(sql, [unameOrEmail]);
  return result.rows[0];
}

// Note: Case-insensitive
exports.findUserByEmail = wrapTimer(findUserByEmail);
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
exports.findUserByUname = wrapTimer(findUserByUname);
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


// `beforeId` is undefined or a number
exports.findRecentPostsForUserId = wrapTimer(findRecentPostsForUserId);
function* findRecentPostsForUserId(userId, beforeId) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));
  var sql = m(function() {/*
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum"
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.user_id = $1 AND p.id < $3
ORDER BY p.id DESC
LIMIT $2
  */});
  var result = yield query(sql, [
    userId,
    config.RECENT_POSTS_PER_PAGE,
    beforeId || 1e9
  ]);
  return result.rows;
}

exports.findUser = wrapTimer(findUser);
function *findUser(userId) {
  debug('[findUser] userId: ' + userId);
  var sql = m(function() {/*
SELECT *
FROM users
WHERE id = $1
  */});
  var result = yield query(sql, [userId]);
  return result.rows[0] || null;
}

// Returns an array of Users
// (Case insensitive uname lookup)
exports.findUsersByUnames = wrapTimer(findUsersByUnames);
function* findUsersByUnames(unames) {
  assert(_.isArray(unames));
  assert(_.every(unames, _.isString));
  unames = unames.map(function(s) { return s.toLowerCase(); });
  var sql = m(function() {/*
SELECT u.*
FROM users u
WHERE lower(u.uname) = ANY ($1::text[])
  */});
  var result = yield query(sql, [unames]);
  return result.rows;
};

// If toUsrIds is not given, then it's a self-convo
// TODO: Wrap in transaction, Document the args of this fn
exports.createConvo = function*(args) {
  debug('[createConvo] args: ', args);
  assert(_.isNumber(args.userId));
  assert(_.isUndefined(args.toUserIds) || _.isArray(args.toUserIds));
  assert(_.isString(args.title));
  assert(_.isString(args.markup));
  assert(_.isString(args.html));
  var convoSql = m(function() {/*
INSERT INTO convos (user_id, title) VALUES ($1, $2) RETURNING *
  */});
  var pmSql = m(function() {/*
INSERT INTO pms
  (convo_id, user_id, ip_address, markup, html, idx)
VALUES ($1, $2, $3, $4, $5, 0)
RETURNING *
*/});
  var participantSql = m(function() {/*
INSERT INTO convos_participants (convo_id, user_id)
VALUES ($1, $2)
*/});

  return yield withTransaction(function*(client) {
    var result;
    result = yield client.queryPromise(convoSql, [args.userId, args.title]);
    var convo = result.rows[0];

    // Run these in parallel
    var results = yield args.toUserIds.map(function(toUserId) {
      return client.queryPromise(participantSql, [convo.id, toUserId]);
    }).concat([
      client.queryPromise(participantSql, [convo.id, args.userId]),
      client.queryPromise(pmSql, [
        convo.id, args.userId, args.ipAddress, args.markup, args.html
      ])
    ]);

    // Assoc firstPm to the returned convo
    convo.firstPm = _.last(results).rows[0];
    convo.pms_count++;  // This is a stale copy so we need to manually inc
    return convo;
  });
};

// Only returns user if reset token has not expired
// so this can be used to verify tokens
exports.findUserByResetToken = wrapTimer(findUserByResetToken);
function* findUserByResetToken(resetToken) {

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

exports.findUserBySessionId = wrapTimer(findUserBySessionId);
function *findUserBySessionId(sessionId) {
  assert(belt.isValidUuid(sessionId));
  var sql = m(function() {/*
UPDATE users
SET last_online_at = NOW()
WHERE id = (
  SELECT u.id
  FROM users u
  WHERE u.id = (
    SELECT s.user_id
    FROM active_sessions s
    WHERE s.id = $1
  )
)
RETURNING *
  */});
  return (yield query(sql, [sessionId])).rows[0];
}

exports.createSession = wrapOptionalClient(createSession);
function *createSession(client, props) {
  debug('[createSession] props: ', props);
  assert(belt.isDBClient(client));
  assert(_.isNumber(props.userId));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.interval));
  var uuid = belt.generateUuid();
  var sql = m(function () {/*
INSERT INTO sessions (user_id, id, ip_address, expired_at)
VALUES ($1, $2, $3::inet, NOW() + $4::interval)
RETURNING *
  */});
  var result = yield client.queryPromise(sql, [
    props.userId, uuid, props.ipAddress, props.interval
  ]);
  return result.rows[0];
};

// FIXME: Quick-hack query
exports.findTopicsByForumId = wrapTimer(findTopicsByForumId);
function* findTopicsByForumId(forumId, limit, offset) {
  debug('[%s] forumId: %s, limit: %s, offset: %s',
        'findTopicsByForumId', forumId, limit, offset);
  var sql = m(function() {/*
(SELECT
  t.*,
  to_json(u.*) "user",
  to_json(p.*) "latest_post",
  to_json(u2.*) "latest_user",
  NULL "forum" -- don't need this for stickies
FROM topics t
JOIN users u ON t.user_id = u.id
LEFT JOIN posts p ON t.latest_post_id = p.id
LEFT JOIN users u2 ON p.user_id = u2.id
WHERE t.forum_id = $1 AND t.is_sticky
ORDER BY t.latest_post_id DESC
LIMIT $2
OFFSET $3)

UNION ALL

(SELECT
  t.*,
  to_json(u.*) "user",
  to_json(p.*) "latest_post",
  to_json(u2.*) "latest_user",
  to_json(f.*) "forum"
FROM topics t
JOIN users u ON t.user_id = u.id
LEFT JOIN posts p ON t.latest_post_id = p.id
LEFT JOIN users u2 ON p.user_id = u2.id
LEFT JOIN forums f ON t.forum_id = f.id
WHERE
  (t.forum_id = $1 OR t.moved_from_forum_id = $1)
  AND NOT t.is_sticky
ORDER BY COALESCE(t.moved_at, t.latest_post_at) DESC
LIMIT $2
OFFSET $3)
  */});
  var result = yield query(sql, [forumId, limit, offset]);
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

// Keep updatePost and updatePm in sync
exports.updatePost = function*(postId, markup, html) {
  assert(_.isString(markup));
  assert(_.isString(html));
  var sql = m(function() {/*
UPDATE posts
SET markup = $2, html = $3, updated_at = NOW()
WHERE id = $1
RETURNING *
  */});
  var result = yield query(sql, [postId, markup, html]);
  return result.rows[0];
};

// Keep updatePost and updatePm in sync
exports.updatePm = function*(id, markup, html) {
  assert(_.isString(markup));
  assert(_.isString(html));
  var sql = m(function() {/*
UPDATE pms
SET markup = $2, html = $3, updated_at = NOW()
WHERE id = $1
RETURNING *
  */});
  var result = yield query(sql, [id, markup, html]);
  return result.rows[0];
};

// Attaches topic and forum to post for authorization checks
// See cancan.js 'READ_POST'
exports.findPostWithTopicAndForum = wrapTimer(findPostWithTopicAndForum);
function* findPostWithTopicAndForum(postId) {
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
exports.findPostById = wrapTimer(findPost);
exports.findPost = wrapTimer(findPost);
function* findPost(postId) {
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
exports.findPmById = wrapTimer(findPm);
exports.findPm = wrapTimer(findPm);
function* findPm(id) {
  var sql = m(function() {/*
SELECT
  pms.*,
  to_json(c.*) "convo"
FROM pms
JOIN convos c ON pms.convo_id = c.id
WHERE pms.id = $1
  */});
  var result = yield query(sql, [id]);
  return result.rows[0];
};

exports.findUsersContainingString = wrapTimer(findUsersContainingString);
function* findUsersContainingString(searchTerm) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm));
    var sql = m(function() {/*
  SELECT *
  FROM users
  WHERE lower(uname) LIKE '%' || lower($1::text) || '%'
  ORDER BY id DESC
  LIMIT $2::bigint
    */});
  var result = yield query(sql, [searchTerm, config.USERS_PER_PAGE]);
  return result.rows;
}

exports.findAllUsers = wrapTimer(findAllUsers);
function* findAllUsers(beforeId) {
    var sql = m(function() {/*
  SELECT *
  FROM users
  WHERE id < $2
  ORDER BY id DESC
  LIMIT $1::bigint
    */});
  var result = yield query(sql, [config.USERS_PER_PAGE, beforeId || 1e9]);
  return result.rows;
}

exports.findUsersContainingStringWithId = wrapTimer(findUsersContainingStringWithId);
function* findUsersContainingStringWithId(searchTerm, beforeId) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm));
  var sql = m(function() {/*
SELECT *
FROM users
WHERE
lower(uname) LIKE '%' || lower($1::text) || '%'
AND id < $2
ORDER BY id DESC
LIMIT $3::bigint
  */});
  var result = yield query(sql, [searchTerm, beforeId, config.USERS_PER_PAGE]);
  return result.rows;
}

exports.findConvosInvolvingUserId = wrapTimer(findConvosInvolvingUserId);
function* findConvosInvolvingUserId(userId, beforeId) {
  // beforeId is the id of convo.latest_pm_id since that's how
  // convos are sorted
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));
  var sql = m(function() {/*
SELECT
  c.id,
  c.title,
  c.created_at,
  c.latest_pm_id,
  c.pms_count,
  u1.uname "user.uname",
  u1.slug "user.slug",
  json_agg(u2.uname) "participant_unames",
  json_agg(u2.slug) "participant_slugs",
  pms.id "latest_pm.id",
  pms.created_at "latest_pm.created_at",
  u3.uname "latest_user.uname",
  u3.slug "latest_user.slug"
FROM convos c
JOIN convos_participants cp ON c.id = cp.convo_id
JOIN users u1 ON c.user_id = u1.id
JOIN users u2 ON cp.user_id = u2.id
JOIN pms ON c.latest_pm_id = pms.id
JOIN users u3 ON pms.user_id = u3.id
WHERE c.latest_pm_id < $2 AND c.id IN (
  SELECT cp.convo_id
  FROM convos_participants cp
  WHERE cp.user_id = $1
)
GROUP BY c.id, u1.id, pms.id, u3.id
ORDER BY c.latest_pm_id DESC
LIMIT $3
  */});
  var result = yield query(sql, [userId, beforeId || 1e9, config.CONVOS_PER_PAGE]);
  return result.rows.map(function(row) {
    row.user = {
      uname: row['user.uname'],
      slug: row['user.slug']
    };
    delete row['user.uname'];
    delete row['user.slug'];

    row.participants = row['participant_unames'].map(function(uname, idx) {
      return {
        uname: uname,
        slug: row['participant_slugs'][idx]
      };
    });
    delete row['participant_unames'];
    delete row['participant_slugs'];

    row.latest_pm = {
      id: row['latest_pm.id'],
      created_at: row['latest_pm.created_at']
    };
    delete row['latest_pm.id'];
    delete row['latest_pm.created_at'];

    row.latest_user = {
      uname: row['latest_user.uname'],
      slug: row['latest_user.slug']
    };
    delete row['latest_user.uname'];
    delete row['latest_user.slug'];

    return row;
  });
};

exports.findConvo = wrapTimer(findConvo);
function* findConvo(convoId) {
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

exports.findPmsByConvoId = function*(convoId, page) {
  var sql = m(function() {/*
SELECT
  pms.*,
  to_json(u.*) "user"
FROM pms
JOIN users u ON pms.user_id = u.id
WHERE pms.convo_id = $1 AND pms.idx >= $2 AND pms.idx < $3
GROUP BY pms.id, u.id
ORDER BY pms.id
  */});
  var fromIdx = (page - 1) * config.POSTS_PER_PAGE;
  var toIdx = fromIdx + config.POSTS_PER_PAGE;
  var result = yield query(sql, [convoId, fromIdx, toIdx]);
  return result.rows;
};

exports.findPostsByTopicId = wrapTimer(findPostsByTopicId);
function* findPostsByTopicId(topicId, postType, page) {
  debug('[findPostsByTopicId] topicId: %s, postType: %s, page',
        topicId, postType, page);
  assert(_.isNumber(page));
  var sql = m(function() {/*
SELECT
  p.*,
  to_json(u.*) "user",
  to_json(t.*) "topic",
  to_json(f.*) "forum"
FROM posts p
JOIN users u ON p.user_id = u.id
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.topic_id = $1 AND p.type = $2 AND p.idx >= $3 AND p.idx < $4
GROUP BY p.id, u.id, t.id, f.id
ORDER BY p.id
  */});
  var fromIdx = (page - 1) * config.POSTS_PER_PAGE;
  var toIdx = fromIdx + config.POSTS_PER_PAGE;
  debug('%s <= post.idx < %s', fromIdx, toIdx);
  var result = yield query(sql, [topicId, postType, fromIdx, toIdx]);
  return result.rows;
};

// TODO: Order by
// TODO: Pagination
exports.findForumWithTopics = wrapTimer(findForumWithTopics);
function* findForumWithTopics(forumId) {
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
exports.findPostWithTopic = wrapTimer(findPostWithTopic);
function* findPostWithTopic(postId) {
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
exports.findPmWithConvo = wrapTimer(findPmWithConvo);
function* findPmWithConvo(pmId) {
  var sql = m(function() {/*
SELECT
  pms.*,
  to_json(c.*) "convo",
  to_json(array_agg(u.*)) "participants"
FROM pms
JOIN convos c ON pms.convo_id = c.id
JOIN convos_participants cp ON cp.convo_id = pms.convo_id
JOIN users u ON cp.user_id = u.id
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
  assert(_.isString(props.markup));
  assert(_.isString(props.html));
  var sql = m(function() {/*
INSERT INTO pms (user_id, ip_address, convo_id, markup, html)
VALUES ($1, $2::inet, $3, $4, $5)
RETURNING *
  */});
  var result = yield query(sql, [
    props.userId,
    props.ipAddress,
    props.convoId,
    props.markup,
    props.html
  ]);
  return result.rows[0];
};

// Args:
// - userId      Required Number/String
// - ipAddress   Optional String
// - markup      Required String
// - topicId     Required Number/String
// - type        Required String, ic | ooc | char
// - isRoleplay  Required Boolean
exports.createPost = function*(args) {
  assert(_.isNumber(args.userId));
  assert(_.isString(args.ipAddress));
  assert(_.isString(args.markup));
  assert(_.isString(args.html));
  assert(args.topicId);
  assert(_.isBoolean(args.isRoleplay));
  assert(_.contains(['ic', 'ooc', 'char'], args.type));
  var sql = m(function() {/*
INSERT INTO posts (user_id, ip_address, topic_id, markup, html, type, is_roleplay)
VALUES ($1, $2::inet, $3, $4, $5, $6, $7)
RETURNING *
  */});
  var result = yield query(sql, [args.userId, args.ipAddress, args.topicId, args.markup, args.html, args.type, args.isRoleplay]);
  return result.rows[0];
};

// Args:
// - userId     Required Number/String
// - forumId    Required Number/String
// - ipAddress  Optional String
// - title      Required String
// - markup     Required String
// - postType   Required String, ic | ooc | char
// - isRoleplay Required Boolean
//
exports.createTopic = function*(props) {
  debug('[createTopic]');
  assert(_.isNumber(props.userId));
  assert(props.forumId);
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.title));
  assert(_.isString(props.markup));
  assert(_.isString(props.html));
  assert(_.isBoolean(props.isRoleplay));
  assert(_.contains(['ic', 'ooc', 'char'], props.postType));
  var topicSql = m(function() {/*
INSERT INTO topics (forum_id, user_id, title, is_roleplay)
VALUES ($1, $2, $3, $4)
RETURNING *
  */});
  var postSql = m(function() {/*
INSERT INTO posts (topic_id, user_id, ip_address, markup, html, type, is_roleplay, idx)
VALUES ($1, $2, $3::inet, $4, $5, $6, $7, 0)
RETURNING *
  */});

  return yield withTransaction(function*(client) {
    var topicResult = yield client.queryPromise(topicSql, [
      props.forumId, props.userId, props.title, props.isRoleplay
    ]);
    var topic = topicResult.rows[0];
    yield client.queryPromise(postSql, [
      topic.id, props.userId, props.ipAddress,
      props.markup, props.html, props.postType, props.isRoleplay
    ]);
    return topic;
  });
};

// Generic user-update route. Intended to be paired with
// the generic PUT /users/:userId route.
exports.updateUser = function*(userId, attrs) {
  debug('[updateUser] attrs', attrs);
  var sql = m(function() {/*
UPDATE users
SET
  email = COALESCE($2, email),
  sig = COALESCE($3, sig),
  avatar_url = COALESCE($4, avatar_url),
  hide_sigs = COALESCE($5, hide_sigs),
  is_ghost = COALESCE($6, is_ghost),
  sig_html = COALESCE($7, sig_html)
WHERE id = $1
RETURNING *
  */});
  var result = yield query(sql, [
    userId,
    attrs.email,
    attrs.sig,
    attrs.avatar_url,
    attrs.hide_sigs,
    attrs.is_ghost,
    attrs.sig_html
  ]);
  return result.rows[0];
};

exports.updateUserRole = function*(userId, role) {
  var sql = m(function() {/*
UPDATE users
SET role = $2
WHERE id = $1
RETURNING *
  */});
  var result = yield query(sql, [userId, role]);
  return result.rows[0];
};

exports.findForumById = wrapTimer(findForum);
exports.findForum = wrapTimer(findForum);
function* findForum(forumId) {
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

exports.findLatestUsers = wrapTimer(findLatestUsers);
function* findLatestUsers(limit) {
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
  var MOD_CATEGORY_ID = 4;
  var sql = m(function() {/*
SELECT c.*
FROM categories c
WHERE c.id = $1
  */});
  var result = yield query(sql, [MOD_CATEGORY_ID]);
  return result.rows[0];
};

// Only returns non-mod-forum categories
exports.findCategories = wrapTimer(findCategories);
function* findCategories() {
  var sql = m(function() {/*
SELECT c.*
FROM categories c
ORDER BY c.pos
  */});
  var result = yield query(sql);
  return result.rows;
};

exports.findCategoriesWithForums = findCategoriesWithForums;
function* findCategoriesWithForums() {
  var sql = m(function() {/*
SELECT
  c.*,
	array_agg(
    json_build_object(
      'id', f.id,
      'title', f.title,
      'pos', f.pos,
      'description', f.description,
      'category_id', f.category_id,
      'parent_forum_id', f.parent_forum_id,
      'latest_user', (
        SELECT json_build_object(
          'uname', u.uname,
          'slug', u.slug
        )
        FROM users u
        WHERE u.id = p.user_id
      ),
      'latest_topic', (
        SELECT json_build_object('id', t.id, 'title', t.title)
        FROM topics t
        WHERE t.id = p.topic_id
      ),
      'latest_post', (
        SELECT json_build_object(
          'id', p.id,
          'created_at', p.created_at
        )
      )
    )
	) "forums"
FROM categories c
JOIN forums f ON c.id = f.category_id
JOIN posts p ON f.latest_post_id = p.id
GROUP BY c.id
ORDER BY c.pos
  */});
  var result = yield query(sql);
  var categories = result.rows;
  categories = categories.map(function(c) {
    c.forums = _.sortBy(c.forums, 'pos');
    return c;
  });
  return categories;
}

// Creates a user and a session (logs them in).
// - Returns {:user <User>, :session <Session>}
// - Use `createUser` if you only want to create a user.
//
// Throws: 'UNAME_TAKEN', 'EMAIL_TAKEN'
exports.createUserWithSession = createUserWithSession;
function *createUserWithSession(props) {
  debug('[createUserWithSession] props: ', props);
  assert(_.isString(props.uname));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.password));
  assert(_.isString(props.email));

  var digest = yield belt.hashPassword(props.password);
  var slug = belt.slugifyUname(props.uname);
  var sql = m(function () {/*
INSERT INTO users (uname, digest, email, slug)
VALUES ($1, $2, $3, $4)
RETURNING *;
   */});

  return yield withTransaction(function*(client) {
    var user, session;
    try {
      user = (yield client.queryPromise(sql, [
        props.uname, digest, props.email, slug
      ])).rows[0];
    } catch(ex) {
      if (ex.code === '23505')
        if (/unique_username/.test(ex.toString()))
          throw 'UNAME_TAKEN';
        else if (/unique_email/.test(ex.toString()))
          throw 'EMAIL_TAKEN';
      throw ex;
    }

    session = yield createSession(client, {
      userId: user.id,
      ipAddress: props.ipAddress,
      interval: '1 year'  // TODO: Decide how long to log user in upon registration
    });

    return { user: user, session: session };
  });
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
exports.findSubscribedTopicsForUserId = wrapTimer(findSubscribedTopicsForUserId);
function* findSubscribedTopicsForUserId(userId) {
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
ORDER BY t.latest_post_id DESC
  */});
  var result = yield query(sql, [userId]);
  return result.rows;
};

exports.findForums = wrapTimer(findForums);
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

// Stats

// https://wiki.postgresql.org/wiki/Count_estimate
exports.getApproxCount = wrapTimer(getApproxCount);
function* getApproxCount(tableName) {
  assert(_.isString(tableName));
  var sql = 'SELECT reltuples "count" FROM pg_class WHERE relname = $1';
  var result = yield query(sql, [tableName]);
  return result.rows[0].count;
}

exports.getLatestUser = wrapTimer(getLatestUser);
function* getLatestUser() {
  var sql = 'SELECT * FROM users ORDER BY created_at DESC LIMIT 1';
  var result = yield query(sql);
  return result.rows[0];
}

// Users online within 15 min
exports.getOnlineUsers = wrapTimer(getOnlineUsers);
function* getOnlineUsers() {
  var sql = m(function() {/*
SELECT *
FROM users
WHERE last_online_at > NOW() - interval '15 minutes'
ORDER BY uname
  */});
  var result = yield query(sql);
  return result.rows;
}

var getMaxTopicId = function*() {
  var result = yield query('SELECT MAX(id) "max_id" FROM topics');
  return result.rows[0].max_id;
};

var getMaxPostId = function*() {
  var result = yield query('SELECT MAX(id) "max_id" FROM posts');
  return result.rows[0].max_id;
};

var getMaxUserId = function*() {
  var result = yield query('SELECT MAX(id) "max_id" FROM users');
  return result.rows[0].max_id;
};

exports.getStats = wrapTimer(getStats);
function* getStats() {
  var results = yield {
    // I switched the getApproxCount fns out for MaxId fns because
    // the vacuuming threshold was too high and the stats were never getting
    // updated
    topicsCount: getMaxTopicId(), //getApproxCount('topics'),
    usersCount: getMaxUserId(), //getApproxCount('users'),
    postsCount: getMaxPostId(), //getApproxCount('posts'),
    latestUser: exports.getLatestUser(),
    onlineUsers: exports.getOnlineUsers()
  };
  return results;
}

exports.deleteUser = function*(id) {
  var sql = 'DELETE FROM users WHERE id = $1';
  yield query(sql, [id]);
};

exports.deleteLegacySig = function*(userId) {
  var sql = 'UPDATE users SET legacy_sig = NULL WHERE id = $1';
  yield query(sql, [userId]);
};

exports.findStaffUsers = function*() {
  var sql = m(function(){/*
SELECT u.*
FROM users u
WHERE u.role IN ('mod', 'smod', 'admin')
  */});
  var result = yield query(sql);
  return result.rows;
};

// Users receive this when someone starts a convo with them
exports.createConvoNotification = wrapOptionalClient(createConvoNotification);
function* createConvoNotification(client, opts) {
  assert(_.isNumber(opts.from_user_id));
  assert(_.isNumber(opts.to_user_id));
  assert(opts.convo_id);
  var sql = m(function(){/*
INSERT INTO notifications (type, from_user_id, to_user_id, convo_id, count)
VALUES ('CONVO', $1, $2, $3, 1)
RETURNING *
  */});
  var result = yield client.queryPromise(sql, [
    opts.from_user_id, opts.to_user_id, opts.convo_id
  ]);
  return result.rows;
};

// Tries to create a convo notification.
// If to_user_id already has a convo notification for this convo, then
// increment the count
exports.createPmNotification = createPmNotification;
function* createPmNotification(opts) {
  debug('[createPmNotification] opts: ', opts);
  assert(_.isNumber(opts.from_user_id));
  assert(_.isNumber(opts.to_user_id));
  assert(opts.convo_id);
  return yield withTransaction(function*(client) {
    try {
      yield exports.createConvoNotification({
        from_user_id: opts.from_user_id,
        to_user_id: opts.to_user_id,
        convo_id: opts.convo_id
      })
    } catch(ex) {
      // Unique constraint violation
      if (ex.code === '23505') {
        var sql = m(function() {/*
          UPDATE notifications
          SET count = COALESCE(count, 0) + 1
          WHERE convo_id = $1 AND to_user_id = $2
        */});
        yield client.queryPromise(sql, [opts.convo_id, opts.to_user_id]);
        return;
      }
      // Else throw
      throw ex;
    }
  });
};

exports.findParticipantIds = function*(convoId) {
  var sql = m(function() {/*
    SELECT user_id
    FROM convos_participants
    WHERE convo_id = $1
  */});
  var result = yield query(sql, [convoId]);
  return _.pluck(result.rows, 'user_id')
};

exports.findNotificationsForUserId = function*(toUserId) {
  var sql = m(function() {/*
    SELECT *
    FROM notifications
    WHERE to_user_id = $1
  */});
  var result = yield query(sql, [toUserId]);
  return result.rows;
};

// Returns how many rows deleted
exports.deleteConvoNotification = function*(toUserId, convoId) {
  var sql = m(function() {/*
    DELETE FROM notifications
    WHERE type = 'CONVO' AND to_user_id = $1 AND convo_id = $2
  */});
  var result = yield query(sql, [toUserId, convoId]);
  return result.rowCount;
};

// Deletes all rows in notifications table for user,
// and also resets the counter caches
exports.clearNotifications = function*(toUserId) {
  var sql1 = m(function() {/*
    DELETE FROM notifications
    WHERE to_user_id = $1
  */});

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  var sql2 = m(function() {/*
    UPDATE users
    SET
      notifications_count = 0,
      convo_notifications_count = 0
    WHERE id = $1
  */});
  yield query(sql1, [toUserId])
  yield query(sql2, [toUserId])
};

exports.clearConvoNotifications = function*(toUserId) {
  var sql1 = m(function() {/*
    DELETE FROM notifications
    WHERE to_user_id = $1 AND type = 'CONVO'
  */});

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  var sql2 = m(function() {/*
    UPDATE users
    SET convo_notifications_count = 0
    WHERE id = $1
  */});
  yield query(sql1, [toUserId]);
  yield query(sql2, [toUserId]);
};

// Returns [String]
exports.findAllUnames = function*() {
  var sql = 'SELECT uname FROM users ORDER BY uname';
  var result = yield query(sql);
  return _.pluck(result.rows, 'uname');
};

exports.findTopicById = function*(topicId) {
  assert(topicId);
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

// props:
// - title Required String
exports.updateTopic = function*(topicId, props) {
  assert(topicId);
  assert(_.isString(props.title));
  var sql = m(function() {/*
    UPDATE topics
    SET title = $2
    WHERE id = $1
    RETURNING *
  */});
  var result = yield query(sql, [topicId, props.title]);
  return result.rows[0];
};

////////////////////////////////////////////////////////////

exports.createMentionNotification = function*(opts) {
  assert(opts.from_user_id);
  assert(opts.to_user_id);
  assert(opts.post_id);
  assert(opts.topic_id);
  var sql = m(function() {/*
    INSERT INTO notifications
    (type, from_user_id, to_user_id, topic_id, post_id)
    VALUES ('MENTION', $1, $2, $3, $4)
    RETURNING *
  */});
  var result = yield query(sql, [
    opts.from_user_id,  // $1
    opts.to_user_id,  // $2
    opts.topic_id, // $3
    opts.post_id // $4
  ]);
  return result.rows[0];
};

exports.parseAndCreateMentionNotifications = function*(props) {
  debug('[parseAndCreateMentionNotifications] Started...');
  assert(props.fromUser.id);
  assert(props.fromUser.uname);
  assert(props.markup);
  assert(props.post_id);
  assert(props.topic_id);

  // Array of lowercase unames that don't include fromUser
  var mentionedUnames = belt.extractMentions(props.markup, props.fromUser.uname);
  mentionedUnames = _.take(mentionedUnames, config.MENTIONS_PER_POST);

  // Ensure these are users
  var mentionedUsers = yield exports.findUsersByUnames(mentionedUnames);

  var thunks = mentionedUsers.map(function(toUser) {
    return exports.createMentionNotification({
      from_user_id: props.fromUser.id,
      to_user_id:   toUser.id,
      post_id:      props.post_id,
      topic_id:     props.topic_id
    });
  });

  var results = yield coParallel(thunks, 5);

  return results;
};

exports.createQuoteNotification = function*(opts) {
  assert(opts.from_user_id);
  assert(opts.to_user_id);
  assert(opts.post_id);
  assert(opts.topic_id);
  var sql = m(function() {/*
    INSERT INTO notifications
    (type, from_user_id, to_user_id, topic_id, post_id)
    VALUES ('QUOTE', $1, $2, $3, $4)
    RETURNING *
  */});
  var result = yield query(sql, [
    opts.from_user_id,  // $1
    opts.to_user_id,  // $2
    opts.topic_id, // $3
    opts.post_id // $4
  ]);
  return result.rows[0];
};

// Keep in sync with db.parseAndCreateMentionNotifications
exports.parseAndCreateQuoteNotifications = function*(props) {
  debug('[parseAndCreateQuoteNotifications] Started...');
  assert(props.fromUser.id);
  assert(props.fromUser.uname);
  assert(props.markup);
  assert(props.post_id);
  assert(props.topic_id);

  // Array of lowercase unames that don't include fromUser
  var mentionedUnames = belt.extractQuoteMentions(props.markup, props.fromUser.uname);
  mentionedUnames = _.take(mentionedUnames, config.QUOTES_PER_POST);

  // Ensure these are users
  var mentionedUsers = yield exports.findUsersByUnames(mentionedUnames);

  var thunks = mentionedUsers.map(function(toUser) {
    return exports.createQuoteNotification({
      from_user_id: props.fromUser.id,
      to_user_id:   toUser.id,
      post_id:      props.post_id,
      topic_id:     props.topic_id
    });
  });

  var results = yield coParallel(thunks, 5);

  return results;
};

exports.findReceivedNotificationsForUserId = function*(toUserId) {
  var sql = m(function() {/*
SELECT
	n.*,
	to_json(u.*) "from_user",
  CASE
    WHEN n.convo_id IS NOT NULL
    THEN
			json_build_object (
				'id', n.convo_id,
				'title', c.title
			)
  END "convo",
  CASE
    WHEN n.topic_id IS NOT NULL
    THEN
			json_build_object (
				'id', n.topic_id,
				'title', t.title
			)
  END "topic",
  CASE
    WHEN n.post_id IS NOT NULL
    THEN
			json_build_object (
				'id', n.post_id,
        'html', p.html
			)
  END "post"
FROM notifications n
JOIN users u ON n.from_user_id = u.id
LEFT OUTER JOIN convos c ON n.convo_id = c.id
LEFT OUTER JOIN topics t ON n.topic_id = t.id
LEFT OUTER JOIN posts p ON n.post_id = p.id
WHERE n.to_user_id = $1
ORDER BY n.id DESC
  */});
  var result = yield query(sql, [toUserId]);
  return result.rows;
};

// Returns how many rows deleted
exports.deleteNotificationsForPostId = function*(toUserId, postId) {
  assert(toUserId);
  assert(postId);
  var sql = m(function() {/*
    DELETE FROM notifications
    WHERE to_user_id = $1 AND post_id = $2
  */});
  var result = yield query(sql, [toUserId, postId]);
  return result.rowCount;
};

// Viewer tracker /////////////////////////////////////////////////

// - ctx is the Koa context
// - topicId is optional
// If user.is_hidden, then we count them as a guest
exports.upsertViewer = function*(ctx, forumId, topicId) {
  assert(_.isObject(ctx));
  assert(forumId);

  // First, try to insert

  var sql, params;
  if (ctx.currUser && !ctx.currUser.is_ghost) {
    sql = m(function() {/*
INSERT INTO viewers (uname, forum_id, topic_id, viewed_at)
VALUES ($1, $2, $3, NOW())
    */});
    params = [ctx.currUser.uname, forumId, topicId];
  } else {
    sql = m(function() {/*
INSERT INTO viewers (ip, forum_id, topic_id, viewed_at)
VALUES ($1, $2, $3, NOW())
    */});
    params = [ctx.ip, forumId, topicId];
  }

  var result;
  for (var i = 0; i < 100; i++) {
    try {
      return yield query(sql, params);
    } catch(ex) {
      // If it fails, if it was unique violation (already existed), then
      // update the row
      if (ex.code === '23505') {
        if (ctx.currUser && !ctx.currUser.is_ghost) {
          sql = m(function() {/*
            UPDATE viewers
            SET forum_id = $2, topic_id = $3, viewed_at = NOW()
            WHERE uname = $1
          */});
        } else {
          sql = m(function() {/*
            UPDATE viewers
            SET forum_id = $2, topic_id = $3, viewed_at = NOW()
            WHERE ip = $1
          */});
        }
        var result = yield query(sql, params);

        // Only return if we actually updated something
        // Else, loop back so we can insert it
        if (result.rowCount > 0)
          return
      } else {
        throw ex;
      }
    }  // end try/catch
  }  // end for loop

  throw new Error('Query retry limit exceeded 100 attempts');
};

// Returns map of ForumId->Int
exports.getForumViewerCounts = function*() {
  // Query returns { forum_id: Int, viewers_count: Int } for every forum
  sql = m(function() {/*
SELECT
  f.id "forum_id",
  COUNT(v.*) "viewers_count"
FROM forums f
LEFT OUTER JOIN active_viewers v ON f.id = v.forum_id
GROUP BY f.id
  */});
  var result = yield query(sql);

  var output = {};
  result.rows.forEach(function(row) {
    output[row.forum_id] = row.viewers_count;
  });

  return output;
};

// Deletes viewers where viewed_at is older than 15 min ago
// Run this in a cronjob
// Returns Int of viewers deleted
exports.clearExpiredViewers = function*() {
  debug('[clearExpiredViewers] Running');
  var sql = m(function() {/*
DELETE FROM viewers
WHERE viewed_at < NOW() - interval '15 minutes'
  */});
  var result = yield query(sql);
  var count = result.rowCount;
  debug('[clearExpiredViewers] Deleted views: ' + count);
  return count;
};

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
exports.findViewersForTopicId = function*(topicId) {
  assert(topicId);
  var sql = m(function() {/*
SELECT *
FROM active_viewers
WHERE topic_id = $1
ORDER BY uname
  */});
  var result = yield query(sql, [topicId]);
  var viewers = result.rows;

  var output = {
    users: _.filter(viewers, 'uname'),
    guests: _.filter(viewers, 'ip')
  };

  return output;
};

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
exports.findViewersForForumId = function*(forumId) {
  assert(forumId);
  var sql = m(function() {/*
SELECT *
FROM active_viewers
WHERE forum_id = $1
ORDER BY uname
  */});
  var result = yield query(sql, [forumId]);
  var viewers = result.rows;

  var output = {
    users: _.filter(viewers, 'uname'),
    guests: _.filter(viewers, 'ip')
  };

  return output;
};

// leaveRedirect: Bool
exports.moveTopic = function*(topicId, fromForumId, toForumId, leaveRedirect) {
  assert(_.isNumber(toForumId));
  var sql, params, result;
  if (leaveRedirect) {
    sql = m(function() {/*
      UPDATE topics
      SET forum_id = $2, moved_from_forum_id = $3, moved_at = NOW()
      WHERE id = $1
      RETURNING *
    */});
    params = [topicId, toForumId, fromForumId];
  } else {
    sql = m(function() {/*
      UPDATE topics
      SET forum_id = $2, moved_at = NOW()
      WHERE id = $1
      RETURNING *
    */});
    params = [topicId, toForumId];
  }
  result = yield query(sql, params);
  var topic = result.rows[0];

  // TODO: Put this in transaction

  var results = yield [
    query('SELECT * FROM forums WHERE id = $1', [fromForumId]),
    query('SELECT * FROM forums WHERE id = $1', [toForumId])
  ];
  var fromForum = results[0].rows[0];
  var toForum = results[1].rows[0];

  // If moved topic's latest post is newer than destination forum's latest post,
  // then update destination forum's latest post.
  if (topic.latest_post_id > toForum.latest_post_id) {
    debug('[moveTopic] Updating toForum latest_post_id');
    sql = m(function() {/*
UPDATE forums
SET latest_post_id = $2
WHERE id = $1
    */});
    debug('topic.id: %s, topic.latest_post_id: %s', topic.id, topic.latest_post_id);
    yield query(sql, [topic.forum_id, topic.latest_post_id]);
  }

  // Update fromForum.latest_post_id if it was topic.latest_post_id since
  // we moved the topic out of this forum.
  if (topic.latest_post_id === fromForum.latest_post_id) {
    debug('[moveTopic] Updating fromForum.latest_post_id');
    sql = m(function() {/*
UPDATE forums
SET latest_post_id = (
  SELECT MAX(t.latest_post_id) "latest_post_id"
  FROM topics t
  WHERE t.forum_id = $1
)
WHERE id = $1
    */});
    yield query(sql, [fromForumId]);
  }

  return topic;
};
