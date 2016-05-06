"use strict";
/*jshint -W002 */
// Node deps
var path = require('path');
var fs = require('co-fs');
var util = require('util');
// 3rd party
var pg = require('co-pg')(require('pg'));
var _ = require('lodash');
var assert = require('better-assert');
var debug = require('debug')('app:db');
var coParallel = require('co-parallel');
var pgArray = require('postgres-array');
// 1st party
var config = require('../config');
var belt = require('../belt');
var pre = require('../presenters');

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
  };
}

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
    done();
    throw ex;
  }
}

var queryOne = function*(sql, params) {
  var result = yield query(sql, params);
  assert(result.rows.length <= 1);
  return result.rows[0];
};

var queryMany = function*(sql, params) {
  var result = yield query(sql, params);
  return result.rows;
};

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
  var sql = `
UPDATE posts
SET is_hidden = $2
WHERE id = $1
RETURNING *
  `;
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
  var sql = `
UPDATE topics
SET is_sticky = COALESCE($2, is_sticky),
    is_hidden = COALESCE($3, is_hidden),
    is_closed = COALESCE($4, is_closed)
WHERE id = $1
RETURNING *
  `;
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
  var sql = `
INSERT INTO topic_subscriptions (user_id, topic_id)
VALUES ($1, $2)
  `;
  try {
  var result = yield query(sql, [userId, topicId]);
  } catch(ex) {
    if (ex.code === '23505')
      return;
    throw ex;
  }
};

exports.unsubscribeFromTopic = function*(userId, topicId) {
  var sql = `
DELETE FROM topic_subscriptions
WHERE user_id = $1 AND topic_id = $2
  `;
  var result = yield query(sql, [userId, topicId]);
  return;
};

// Same as findTopic but takes a userid so that it can return a topic
// with an is_subscribed boolean for the user
// Keep in sync with db.findTopicById
exports.findTopicWithIsSubscribed = function*(userId, topicId) {
  debug('[findTopicWithIsSubscribed] userId %s, topicId %s:', userId, topicId);

  const sql = `
SELECT
  (
    CASE
      WHEN t.ic_posts_count = 0 THEN false
      ELSE
        (
          SELECT COALESCE(
            (
              SELECT t.latest_ic_post_id > w.watermark_post_id
              FROM topics_users_watermark w
              WHERE w.topic_id = t.id AND w.post_type = 'ic' AND w.user_id = $1
            ),
            true
          )
        )
    END
  ) unread_ic,
  (
    CASE
      WHEN t.ooc_posts_count = 0 THEN false
      ELSE
        (
          SELECT COALESCE(
            (
              SELECT COALESCE(t.latest_ooc_post_id, t.latest_post_id) > w.watermark_post_id
              FROM topics_users_watermark w
              WHERE w.topic_id = t.id AND w.post_type = 'ooc' AND w.user_id = $1
            ),
            true
          )
        )
    END
  ) unread_ooc,
  (
    CASE
      WHEN t.char_posts_count = 0 THEN false
      ELSE
        (
          SELECT COALESCE(
            (
              SELECT t.latest_char_post_id > w.watermark_post_id
              FROM topics_users_watermark w
              WHERE w.topic_id = t.id AND w.post_type = 'char' AND w.user_id = $1
            ),
            true
          )
        )
    END
  ) unread_char,
  t.*,
  to_json(f.*) "forum",
  array_agg($1::int) @> Array[ts.user_id::int] "is_subscribed",
  (SELECT to_json(u2.*) FROM users u2 WHERE u2.id = t.user_id) "user",
  (SELECT json_agg(u3.uname) FROM users u3 WHERE u3.id = ANY (t.co_gm_ids::int[])) co_gm_unames,
  (
   SELECT json_agg(tags.*)
   FROM tags
   JOIN tags_topics ON tags.id = tags_topics.tag_id
   WHERE tags_topics.topic_id = t.id
  ) tags,
  (
    SELECT COALESCE(json_agg(sub.*), '{}'::json)
    FROM (
			SELECT users.uname, arena_outcomes.outcome, u2.uname inserted_by_uname
      FROM arena_outcomes
      JOIN users ON arena_outcomes.user_id = users.id
      JOIN users u2 ON arena_outcomes.inserted_by = u2.id
      WHERE arena_outcomes.topic_id = t.id
    ) sub
  ) arena_outcomes
FROM topics t
JOIN forums f ON t.forum_id = f.id
LEFT OUTER JOIN topic_subscriptions ts ON t.id = ts.topic_id AND ts.user_id = $1
WHERE t.id = $2
GROUP BY t.id, f.id, ts.user_id
  `;

  return yield queryOne(sql, [userId, topicId]);
};

////////////////////////////////////////////////////////////

exports.updateUserBio = function*(userId, bioMarkup, bioHtml) {
  assert(_.isString(bioMarkup));

  const sql = `
    UPDATE users
    SET bio_markup = $2, bio_html = $3
    WHERE id = $1
    RETURNING *
  `;

  return yield queryOne(sql, [userId, bioMarkup, bioHtml]);
};

////////////////////////////////////////////////////////////

exports.findTopic = wrapTimer(findTopic);
function* findTopic(topicId) {
  const sql = `
SELECT
  t.*,
  to_json(f.*) "forum"
FROM topics t
JOIN forums f ON t.forum_id = f.id
WHERE t.id = $1
  `;

  return yield queryOne(sql, [topicId]);
}

////////////////////////////////////////////////////////////

exports.deleteResetTokens = function*(userId) {
  assert(_.isNumber(userId));

  const sql = `
DELETE FROM reset_tokens
WHERE user_id = $1
  `;

  yield query(sql, [userId]);
};

////////////////////////////////////////////////////////////

exports.findLatestActiveResetToken = function*(userId) {
  assert(_.isNumber(userId));

  const sql = `
SELECT *
FROM active_reset_tokens
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 1
  `;

  return yield queryOne(sql, [userId]);
};

////////////////////////////////////////////////////////////

exports.createResetToken = function*(userId) {
  debug('[createResetToken] userId: ' + userId);

  const uuid = belt.generateUuid();
  const sql = `
INSERT INTO reset_tokens (user_id, token)
VALUES ($1, $2)
RETURNING *
  `;

  return yield queryOne(sql, [userId, uuid]);
};

////////////////////////////////////////////////////////////

exports.findUserById = exports.findUser = function*(id) {
  const sql = 'SELECT * FROM users WHERE id = $1';

  return yield queryOne(sql, [id]);
};

////////////////////////////////////////////////////////////

exports.findUserBySlug = exports.getUserBySlug = function*(slug) {
  assert(_.isString(slug));

  const sql = `
SELECT u.*
FROM users u
WHERE u.slug = lower($1)
GROUP BY u.id
  `;

  return yield queryOne(sql, [slug]);
};

////////////////////////////////////////////////////////////

// Only use this if you need ratings table, else use just findUserBySlug
exports.findUserWithRatingsBySlug = function*(slug) {
  assert(_.isString(slug));

  const sql = `
WITH q1 AS (
  SELECT
    COUNT(r) FILTER (WHERE r.type = 'like') like_count,
    COUNT(r) FILTER (WHERE r.type = 'laugh') laugh_count,
    COUNT(r) FILTER (WHERE r.type = 'thank') thank_count
  FROM ratings r
  JOIN users u ON r.to_user_id = u.id
  WHERE u.slug = lower($1)
  GROUP BY r.to_user_id
),
q2 AS (
  SELECT
    COUNT(r) FILTER (WHERE r.type = 'like') like_count,
    COUNT(r) FILTER (WHERE r.type = 'laugh') laugh_count,
    COUNT(r) FILTER (WHERE r.type = 'thank') thank_count
  FROM ratings r
  JOIN users u ON r.from_user_id = u.id
  WHERE u.slug = lower($1)
  GROUP BY r.from_user_id
)

SELECT
  u.*,
  json_build_object(
    'like', COALESCE((SELECT like_count FROM q1), 0),
    'laugh', COALESCE((SELECT laugh_count FROM q1), 0),
    'thank', COALESCE((SELECT thank_count FROM q1), 0)
  ) ratings_received,
  json_build_object(
    'like', COALESCE((SELECT like_count FROM q2), 0),
    'laugh', COALESCE((SELECT laugh_count FROM q2), 0),
    'thank', COALESCE((SELECT thank_count FROM q2), 0)
  ) ratings_given
FROM users u
WHERE u.slug = lower($1)
GROUP BY u.id
  `;

  return yield queryOne(sql, [slug]);
};

////////////////////////////////////////////////////////////

exports.findUserByUnameOrEmail = function*(unameOrEmail) {
  assert(_.isString(unameOrEmail));

  const sql =`
SELECT *
FROM users u
WHERE lower(u.uname) = lower($1) OR lower(u.email) = lower($1);
  `;
  return yield queryOne(sql, [unameOrEmail]);
};

////////////////////////////////////////////////////////////

// Note: Case-insensitive
exports.findUserByEmail = function*(email) {
  debug('[findUserByEmail] email: ' + email);

  const sql = `
SELECT *
FROM users u
WHERE lower(u.email) = lower($1);
  `;

  return yield queryOne(sql, [email]);
};

////////////////////////////////////////////////////////////

// Note: Case-insensitive
exports.findUserByUname = function*(uname) {
  debug('[findUserByUname] uname: ' + uname);

  const sql = `
SELECT *
FROM users u
WHERE lower(u.uname) = lower($1);
  `;

  return yield queryOne(sql, [uname]);
};

////////////////////////////////////////////////////////////

// `beforeId` is undefined or a number
exports.findRecentPostsForUserId = function*(userId, beforeId) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));

  const sql = `
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
  `;

  return yield queryMany(sql, [
    userId,
    config.RECENT_POSTS_PER_PAGE,
    beforeId || 1e9
  ]);
};

////////////////////////////////////////////////////////////

// `beforeId` is undefined or a number
exports.findRecentTopicsForUserId = function*(userId, beforeId) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));

  const sql = `
SELECT
  t.*,
  to_json(f.*) "forum",
  to_json(p.*) first_post
FROM topics t
JOIN forums f ON t.forum_id = f.id
JOIN posts p ON p.id = (
  SELECT MAX(p.id) first_post_id
  FROM posts p
  WHERE p.topic_id = t.id
)
WHERE t.user_id = $1 AND t.id < $3
GROUP BY t.id, f.id, p.id
ORDER BY t.id DESC
LIMIT $2
  `;

  return yield queryMany(sql, [
    userId,
    config.RECENT_POSTS_PER_PAGE,
    beforeId || 1e9
  ]);
};

////////////////////////////////////////////////////////////

exports.findUser = function*(userId) {
  debug('[findUser] userId: ' + userId);

  const sql = `
SELECT *
FROM users
WHERE id = $1
  `;

  return yield queryOne(sql, [userId]);
};

////////////////////////////////////////////////////////////

// Returns an array of Users
// (Case insensitive uname lookup)
exports.findUsersByUnames = function*(unames) {
  assert(_.isArray(unames));
  assert(_.every(unames, _.isString));

  unames = unames.map(s => s.toLowerCase());

  const sql = `
SELECT u.*
FROM users u
WHERE lower(u.uname) = ANY ($1::text[])
  `;

  return yield queryMany(sql, [unames]);
};

////////////////////////////////////////////////////////////

// If toUsrIds is not given, then it's a self-convo
// TODO: Wrap in transaction, Document the args of this fn
exports.createConvo = function*(args) {
  debug('[createConvo] args: ', args);
  assert(_.isNumber(args.userId));
  assert(_.isUndefined(args.toUserIds) || _.isArray(args.toUserIds));
  assert(_.isString(args.title));
  assert(_.isString(args.markup));
  assert(_.isString(args.html));
  var convoSql = `
INSERT INTO convos (user_id, title) VALUES ($1, $2) RETURNING *
  `;
  var pmSql = `
INSERT INTO pms
  (convo_id, user_id, ip_address, markup, html, idx)
VALUES ($1, $2, $3, $4, $5, 0)
RETURNING *
  `;
  var participantSql = `
INSERT INTO convos_participants (convo_id, user_id)
VALUES ($1, $2)
  `;

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

////////////////////////////////////////////////////////////

// Only returns user if reset token has not expired
// so this can be used to verify tokens
exports.findUserByResetToken = function*(resetToken) {

  // Short circuit if it's not even a UUID
  if (!belt.isValidUuid(resetToken))
    return;

  const sql = `
SELECT *
FROM users u
WHERE u.id = (
  SELECT rt.user_id
  FROM active_reset_tokens rt
  WHERE rt.token = $1
)
  `;

  return yield queryOne(sql, [resetToken]);
};

////////////////////////////////////////////////////////////

exports.findUserBySessionId = function*(sessionId) {
  assert(belt.isValidUuid(sessionId));

  const sql = `
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
  `;

  const user = yield queryOne(sql, [sessionId]);
  if (user)
    user.roles = pgArray.parse(user.roles, _.identity);

  return user;
};

////////////////////////////////////////////////////////////

exports.createSession = wrapOptionalClient(createSession);
function *createSession(client, props) {
  debug('[createSession] props: ', props);
  assert(belt.isDBClient(client));
  assert(_.isNumber(props.userId));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.interval));

  const uuid = belt.generateUuid();

  const sql = `
INSERT INTO sessions (user_id, id, ip_address, expired_at)
VALUES ($1, $2, $3::inet, NOW() + $4::interval)
RETURNING *
  `;

  const result = yield client.queryPromise(sql, [
    props.userId, uuid, props.ipAddress, props.interval
  ]);

  return result.rows[0];
}

////////////////////////////////////////////////////////////

// Sync with db.findTopicsWithHasPostedByForumId
exports.findTopicsByForumId = function*(forumId, limit, offset) {
  debug('[%s] forumId: %s, limit: %s, offset: %s',
        'findTopicsByForumId', forumId, limit, offset);

  const sql = `
SELECT
  t.*,
  to_json(u.*) "user",
  to_json(p.*) "latest_post",
  to_json(u2.*) "latest_user",
  to_json(f.*) "forum",
  (
   SELECT json_agg(tags.*)
   FROM tags
   JOIN tags_topics ON tags.id = tags_topics.tag_id
   WHERE tags_topics.topic_id = t.id
  ) tags,
  (
    SELECT COALESCE(json_agg(sub.*), '{}'::json)
    FROM (
      SELECT users.uname, arena_outcomes.outcome
      FROM arena_outcomes
      JOIN users ON arena_outcomes.user_id = users.id
      WHERE arena_outcomes.topic_id = t.id
    ) sub
  ) arena_outcomes
FROM topics t
JOIN users u ON t.user_id = u.id
LEFT JOIN posts p ON t.latest_post_id = p.id
LEFT JOIN users u2 ON p.user_id = u2.id
LEFT JOIN forums f ON t.forum_id = f.id
WHERE t.forum_id = $1
  AND t.is_hidden = false
ORDER BY t.is_sticky DESC, t.latest_post_at DESC
LIMIT $2
OFFSET $3
  `;

  return yield queryMany(sql, [forumId, limit, offset]);
};

////////////////////////////////////////////////////////////

// Sync with db.findTopicsByForumId
// Same as db.findTopicsByForumId except each forum has a has_posted boolean
// depending on whether or not userId has posted in each topic
exports.findTopicsWithHasPostedByForumId = function*(forumId, limit, offset, userId) {
  assert(userId);
  debug('[findTopicsWithHasPostedByForumId] forumId: %s, userId: %s',
        forumId, userId);

  const sql = `
SELECT
  EXISTS(
    SELECT 1 FROM posts WHERE topic_id = t.id AND user_id = $4
  ) has_posted,
  (
    SELECT t.latest_post_id > (
      SELECT COALESCE(MAX(w.watermark_post_id), 0)
      FROM topics_users_watermark w
      WHERE w.topic_id = t.id
        AND w.user_id = $4
    )
  ) unread_posts,
  t.*,
  to_json(u.*) "user",
  to_json(p.*) "latest_post",
  to_json(u2.*) "latest_user",
  to_json(f.*) "forum",
  (
   SELECT json_agg(tags.*)
   FROM tags
   JOIN tags_topics ON tags.id = tags_topics.tag_id
   WHERE tags_topics.topic_id = t.id
  ) tags,
  (
    SELECT COALESCE(json_agg(sub.*), '{}'::json)
    FROM (
      SELECT users.uname, arena_outcomes.outcome
      FROM arena_outcomes
      JOIN users ON arena_outcomes.user_id = users.id
      WHERE arena_outcomes.topic_id = t.id
    ) sub
  ) arena_outcomes
FROM topics t
JOIN users u ON t.user_id = u.id
LEFT JOIN posts p ON t.latest_post_id = p.id
LEFT JOIN users u2 ON p.user_id = u2.id
LEFT JOIN forums f ON t.forum_id = f.id
WHERE t.forum_id = $1
  AND t.is_hidden = false
ORDER BY t.is_sticky DESC, t.latest_post_at DESC
LIMIT $2
OFFSET $3
  `;

  return yield queryMany(sql, [forumId, limit, offset, userId]);
};

////////////////////////////////////////////////////////////

exports.updateUserPassword = function*(userId, password) {
  assert(_.isNumber(userId));
  assert(_.isString(password));

  const digest = yield belt.hashPassword(password);
  const sql = `
UPDATE users
SET digest = $2
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [userId, digest]);
};

////////////////////////////////////////////////////////////

// Keep updatePost and updatePm in sync
exports.updatePost = function*(postId, markup, html) {
  assert(_.isString(markup));
  assert(_.isString(html));

  const sql = `
UPDATE posts
SET markup = $2, html = $3, updated_at = NOW()
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [postId, markup, html]);
};

////////////////////////////////////////////////////////////

// Keep updatePost and updatePm in sync
exports.updatePm = function*(id, markup, html) {
  assert(_.isString(markup));
  assert(_.isString(html));

  const sql = `
UPDATE pms
SET markup = $2, html = $3, updated_at = NOW()
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [id, markup, html]);
};

////////////////////////////////////////////////////////////

// Attaches topic and forum to post for authorization checks
// See cancan.js 'READ_POST'
exports.findPostWithTopicAndForum = function*(postId) {
  const sql = `
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum"
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.id = $1
  `;

  return yield queryOne(sql, [postId]);
};

////////////////////////////////////////////////////////////

// Keep findPost and findPm in sync
exports.findPostById = wrapTimer(findPost);
exports.findPost = wrapTimer(findPost);
function* findPost(postId) {
  const sql = `
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum"
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.id = $1
  `;

  return yield queryOne(sql, [postId]);
}

////////////////////////////////////////////////////////////

exports.findPmById = wrapTimer(findPm);
exports.findPm = wrapTimer(findPm);
function* findPm(id) {
  const sql = `
SELECT
  pms.*,
  to_json(c.*) "convo"
FROM pms
JOIN convos c ON pms.convo_id = c.id
WHERE pms.id = $1
  `;

  return yield queryOne(sql, [id]);
}

////////////////////////////////////////////////////////////

exports.findUsersContainingString = wrapTimer(findUsersContainingString);
function* findUsersContainingString(searchTerm) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm));

  const sql = `
SELECT *
FROM users
WHERE lower(uname) LIKE '%' || lower($1::text) || '%'
ORDER BY id DESC
LIMIT $2::bigint
  `;

  return yield queryMany(sql, [searchTerm, config.USERS_PER_PAGE]);
}

////////////////////////////////////////////////////////////

exports.findAllUsers = function*(beforeId) {
  const sql = `
SELECT *
FROM users
WHERE id < $2
ORDER BY id DESC
LIMIT $1::bigint
  `;
  return yield queryMany(sql, [config.USERS_PER_PAGE, beforeId || 1e9]);
};

////////////////////////////////////////////////////////////

exports.findUsersContainingStringWithId = wrapTimer(findUsersContainingStringWithId);
function* findUsersContainingStringWithId(searchTerm, beforeId) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm));

  const sql = `
SELECT *
FROM users
WHERE
lower(uname) LIKE '%' || lower($1::text) || '%'
AND id < $2
ORDER BY id DESC
LIMIT $3::bigint
  `;

  return yield queryMany(sql, [searchTerm, beforeId, config.USERS_PER_PAGE]);
}

////////////////////////////////////////////////////////////

exports.findConvosInvolvingUserId = function*(userId, folder, page) {
  assert(_.isNumber(page));
  assert(_.contains(['INBOX', 'STAR', 'ARCHIVE', 'TRASH'], folder));

  const offset = config.CONVOS_PER_PAGE * (page-1);
  const limit = config.CONVOS_PER_PAGE;

  const sql = `
SELECT
  c.id,
  c.title,
  c.created_at,
  c.latest_pm_id,
  c.pms_count,
  cp2.folder,
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
JOIN convos_participants cp2 ON c.id = cp2.convo_id
WHERE c.id IN (
    SELECT cp.convo_id
    FROM convos_participants cp
  )
  AND (cp2.folder = $2 AND cp2.user_id = $1)
GROUP BY c.id, u1.id, pms.id, u3.id, cp2.folder
ORDER BY c.latest_pm_id DESC
OFFSET $4
LIMIT $3
  `;

  var result = yield query(sql, [
    userId,
    folder,
    limit,
    offset
  ]);

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
}

////////////////////////////////////////////////////////////

exports.findConvo = function*(convoId) {
  assert(!_.isUndefined(convoId));

  const sql = `
SELECT
  c.*,
  to_json(u1.*) "user",
  to_json(array_agg(u2.*)) "participants",
  json_agg(cp.*) "cp"
FROM convos c
JOIN convos_participants cp ON c.id = cp.convo_id
JOIN users u1 ON c.user_id = u1.id
JOIN users u2 ON cp.user_id = u2.id
WHERE c.id = $1
GROUP BY c.id, u1.id
  `;

  return yield queryOne(sql, [convoId]);
};

////////////////////////////////////////////////////////////

exports.findPmsByConvoId = function*(convoId, page) {
  const sql = `
SELECT
  pms.*,
  to_json(u.*) "user"
FROM pms
JOIN users u ON pms.user_id = u.id
WHERE pms.convo_id = $1 AND pms.idx >= $2 AND pms.idx < $3
GROUP BY pms.id, u.id
ORDER BY pms.id
  `;

  const fromIdx = (page - 1) * config.POSTS_PER_PAGE;
  const toIdx = fromIdx + config.POSTS_PER_PAGE;

  return yield queryMany(sql, [convoId, fromIdx, toIdx]);
};

////////////////////////////////////////////////////////////

exports.findPostsByTopicId = wrapTimer(findPostsByTopicId);
function* findPostsByTopicId(topicId, postType, page) {
  debug('[findPostsByTopicId] topicId: %s, postType: %s, page',
        topicId, postType, page);
  assert(_.isNumber(page));

  const sql = `
SELECT
  p.*,
  to_json(u.*) "user",
  to_json(t.*) "topic",
  to_json(f.*) "forum",
  to_json(s.*) "current_status",
  to_json(array_remove(array_agg(r.*), null)) ratings
FROM posts p
JOIN users u ON p.user_id = u.id
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
LEFT OUTER JOIN ratings r ON p.id = r.post_id
LEFT OUTER JOIN statuses s ON u.current_status_id = s.id
WHERE p.topic_id = $1 AND p.type = $2 AND p.idx >= $3 AND p.idx < $4
GROUP BY p.id, u.id, t.id, f.id, s.id
ORDER BY p.id
  `;

  var fromIdx = (page - 1) * config.POSTS_PER_PAGE;
  var toIdx = fromIdx + config.POSTS_PER_PAGE;
  debug('%s <= post.idx < %s', fromIdx, toIdx);
  var result = yield query(sql, [topicId, postType, fromIdx, toIdx]);
  return result.rows.map(function(row) {
    // Make current_status a property of post.user where it makes more sense
    if (row.current_status)
      row.current_status.created_at = new Date(row.current_status.created_at);
    row.user.current_status = row.current_status;
    delete row.current_status;
    if (row.user.current_status)
      debug('curr: ', row.user.uname);
    return row;
  });
}

////////////////////////////////////////////////////////////

// TODO: Order by
// TODO: Pagination
exports.findForumWithTopics = wrapTimer(findForumWithTopics);
function* findForumWithTopics(forumId) {
  const sql = `
SELECT
  f.*,
  to_json(array_agg(t.*)) "topics",
  to_json(p.*) "latest_post"
FROM forums f
LEFT OUTER JOIN topics t ON f.id = t.forum_id
WHERE f.id = $1
GROUP BY f.id
  `;

  let forum = yield queryOne(sql, [forumId]);
  if (!forum) return null;
  // The query will set forum.topics to `[null]` if it has
  // none, so compact it to just `[]`.
  forum.topics = _.compact(forum.topics);
  return forum;
}

////////////////////////////////////////////////////////////

// Keep findPostWithTopic and findPmWithConvo in sync
exports.findPostWithTopic = wrapTimer(findPostWithTopic);
function* findPostWithTopic(postId) {
  const sql = `
SELECT
  p.*,
  to_json(t.*) "topic"
FROM posts p
JOIN topics t ON p.topic_id = t.id
WHERE p.id = $1
GROUP BY p.id, t.id
  `;

  return yield queryOne(sql, [postId]);
}

////////////////////////////////////////////////////////////

// Keep findPostWithTopic and findPmWithConvo in sync
exports.findPmWithConvo = wrapTimer(findPmWithConvo);
function* findPmWithConvo(pmId) {
  const sql = `
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
  `;

  return yield queryOne(sql, [pmId]);
}

////////////////////////////////////////////////////////////

// Returns created PM
exports.createPm = function*(props) {
  assert(_.isNumber(props.userId));
  assert(props.convoId);
  assert(_.isString(props.markup));
  assert(_.isString(props.html));

  const sql = `
INSERT INTO pms (user_id, ip_address, convo_id, markup, html)
VALUES ($1, $2::inet, $3, $4, $5)
RETURNING *
  `;

  return yield queryOne(sql, [
    props.userId,
    props.ipAddress,
    props.convoId,
    props.markup,
    props.html
  ]);
};

////////////////////////////////////////////////////////////

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

  const sql = `
INSERT INTO posts (user_id, ip_address, topic_id, markup, html, type, is_roleplay)
VALUES ($1, $2::inet, $3, $4, $5, $6, $7)
RETURNING *
  `;

  return yield queryOne(sql, [args.userId, args.ipAddress, args.topicId, args.markup, args.html, args.type, args.isRoleplay]);
};

////////////////////////////////////////////////////////////

// Args:
// - userId     Required Number/String
// - forumId    Required Number/String
// - ipAddress  Optional String
// - title      Required String
// - markup     Required String
// - postType   Required String, ic | ooc | char
// - isRoleplay Required Boolean
// - tagIds     Optional [Int]
// - joinStatus Optional String (Required if roleplay)
// - is_ranked  Optional Boolean (if set, forum.is_arena_rp must === true)
//
exports.createTopic = function*(props) {
  debug('[createTopic]', props);
  assert(_.isNumber(props.userId));
  assert(props.forumId);
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.title));
  assert(_.isString(props.markup));
  assert(_.isString(props.html));
  assert(_.isBoolean(props.isRoleplay));
  assert(_.contains(['ic', 'ooc', 'char'], props.postType));
  assert(_.isArray(props.tagIds) || _.isUndefined(props.tagIds));
  // Only roleplays have join-status
  if (props.isRoleplay)
    assert(_.isString(props.joinStatus));
  else
    assert(_.isUndefined(props.joinStatus));

  props.is_ranked = !!props.is_ranked;

  const topicSql = `
INSERT INTO topics (forum_id, user_id, title, is_roleplay, join_status, is_ranked)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *
  `;
  const postSql = `
INSERT INTO posts (topic_id, user_id, ip_address, markup, html, type, is_roleplay, idx)
VALUES ($1, $2, $3::inet, $4, $5, $6, $7, 0)
RETURNING *
  `;

  return yield withTransaction(function*(client) {
    // Create topic
    var topicResult = yield client.queryPromise(topicSql, [
      props.forumId, props.userId, props.title,
      props.isRoleplay, props.joinStatus, props.is_ranked
    ]);
    var topic = topicResult.rows[0];
    // Create topic's first post
    yield client.queryPromise(postSql, [
      topic.id, props.userId, props.ipAddress,
      props.markup, props.html, props.postType, props.isRoleplay
    ]);

    // Create tags if given
    if (props.tagIds) {
      const promises = props.tagIds.map(function(tagId) {
        const sql = `
INSERT INTO tags_topics (topic_id, tag_id)
VALUES ($1, $2)
        `;
        return client.queryPromise(sql, [topic.id, tagId]);
      });
      yield promises;
    }

    return topic;
  });
};

////////////////////////////////////////////////////////////

// Generic user-update route. Intended to be paired with
// the generic PUT /users/:userId route.
exports.updateUser = function*(userId, attrs) {
  debug('[updateUser] attrs', attrs);

  const sql = `
UPDATE users
SET
  email = COALESCE($2, email),
  sig = COALESCE($3, sig),
  avatar_url = COALESCE($4, avatar_url),
  hide_sigs = COALESCE($5, hide_sigs),
  is_ghost = COALESCE($6, is_ghost),
  sig_html = COALESCE($7, sig_html),
  custom_title = COALESCE($8, custom_title),
  is_grayscale = COALESCE($9, is_grayscale),
  force_device_width = COALESCE($10, force_device_width),
  hide_avatars = COALESCE($11, hide_avatars),
  show_arena_stats = COALESCE($12, show_arena_stats)
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [
    userId,
    attrs.email,
    attrs.sig,
    attrs.avatar_url,
    attrs.hide_sigs,
    attrs.is_ghost,
    attrs.sig_html,
    attrs.custom_title,  // $8
    attrs.is_grayscale,  // $9
    attrs.force_device_width,  // $10
    attrs.hide_avatars,  // $11
    attrs.show_arena_stats // $12
  ]);
};

////////////////////////////////////////////////////////////

exports.updateUserRole = function*(userId, role) {
  const sql = `
UPDATE users
SET role = $2
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [userId, role]);
};

////////////////////////////////////////////////////////////

exports.findForumById = wrapTimer(findForum);
exports.findForum = wrapTimer(findForum);
function* findForum(forumId) {
  const sql = `
SELECT
  f.*,
  to_json(f2.*) "child_forum",
  to_json(f3.*) "parent_forum"
FROM forums f
LEFT OUTER JOIN forums f2 ON f.id = f2.parent_forum_id
LEFT OUTER JOIN forums f3 ON f.parent_forum_id = f3.id
WHERE f.id = $1
GROUP BY f.id, f2.id, f3.id
  `;

  return yield queryOne(sql, [forumId]);
}

////////////////////////////////////////////////////////////

exports.findLatestUsers = wrapTimer(findLatestUsers);
function* findLatestUsers(limit) {
  const sql = `
SELECT u.*
FROM users u
ORDER BY id DESC
LIMIT $1
  `;

  return yield queryMany(sql, [limit || 25]);
}

////////////////////////////////////////////////////////////

// Also has cat.forums array
exports.findModCategory = function*() {
  const MOD_CATEGORY_ID = 4;
  const sql = `
SELECT c.*
FROM categories c
WHERE c.id = $1
  `;

  return yield queryOne(sql, [MOD_CATEGORY_ID]);
};

////////////////////////////////////////////////////////////

// Only returns non-mod-forum categories
exports.findCategories = function*() {
  const sql = `
SELECT c.*
FROM categories c
ORDER BY c.pos
  `;

  return yield queryMany(sql);
};

////////////////////////////////////////////////////////////

exports.findCategoriesWithForums = findCategoriesWithForums;
function* findCategoriesWithForums() {
  const sql = `
SELECT
  c.*,
  array_agg(
    json_build_object(
      'id', f.id,
      'title', f.title,
      'pos', f.pos,
      'posts_count', f.posts_count,
      'topics_count', f.topics_count,
      'description', f.description,
      'category_id', f.category_id,
      'parent_forum_id', f.parent_forum_id,
      'latest_user', (
        SELECT
          CASE
            WHEN p.user_id IS NOT NULL
            THEN
              json_build_object(
                'uname', u.uname,
                'slug', u.slug
              )
          END
        FROM users u
        WHERE u.id = p.user_id
      ),
      'latest_topic', (
        SELECT
          CASE
            WHEN p.topic_id IS NOT NULL
            THEN json_build_object('id', t.id, 'title', t.title)
          END
        FROM topics t
        WHERE t.id = p.topic_id
      ),
      'latest_post', (
        SELECT
          CASE
            WHEN p.id IS NOT NULL
            THEN
              json_build_object(
                'id', p.id,
                'created_at', p.created_at
              )
          END
      )
    )
  ) "forums"
FROM categories c
JOIN forums f ON c.id = f.category_id
LEFT OUTER JOIN posts p ON f.latest_post_id = p.id
GROUP BY c.id
ORDER BY c.pos
  `;

  let categories = yield queryMany(sql);
  categories = categories.map(function(c) {
    c.forums = _.sortBy(c.forums, 'pos');
    return c;
  });
  return categories;
}

////////////////////////////////////////////////////////////

// Creates a user and a session (logs them in).
// - Returns {:user <User>, :session <Session>}
// - Use `createUser` if you only want to create a user.
//
// Throws: 'UNAME_TAKEN', 'EMAIL_TAKEN'
exports.createUserWithSession = function*(props) {
  debug('[createUserWithSession] props: ', props);
  assert(_.isString(props.uname));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.password));
  assert(_.isString(props.email));

  const digest = yield belt.hashPassword(props.password);
  const slug = belt.slugifyUname(props.uname);

  const sql = `
INSERT INTO users (uname, digest, email, slug)
VALUES ($1, $2, $3, $4)
RETURNING *;
   `;

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

////////////////////////////////////////////////////////////

exports.logoutSession = function*(userId, sessionId) {
  assert(_.isNumber(userId));
  assert(_.isString(sessionId) && belt.isValidUuid(sessionId));

  const sql = `
DELETE FROM sessions
WHERE user_id = $1 AND id = $2
  `;

  return yield query(sql, [userId, sessionId]);
};

////////////////////////////////////////////////////////////

// Sort them by latest_posts first
exports.findSubscribedTopicsForUserId = function*(userId) {
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

  return yield queryMany(sql, [userId]);
};

////////////////////////////////////////////////////////////

exports.findForums = function*(categoryIds) {
  assert(_.isArray(categoryIds));

  const sql = `
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
  `;

  return yield queryMany(sql, [categoryIds]);
};

////////////////////////////////////////////////////////////

// Stats

// https://wiki.postgresql.org/wiki/Count_estimate
exports.getApproxCount = function*(tableName) {
  assert(_.isString(tableName));
  const sql = 'SELECT reltuples "count" FROM pg_class WHERE relname = $1';
  const row = yield queryOne(sql, [tableName]);
  return row.count;
};

////////////////////////////////////////////////////////////

exports.getLatestUser = function*() {
  const sql = 'SELECT * FROM users ORDER BY created_at DESC LIMIT 1';
  return yield queryOne(sql);
};

////////////////////////////////////////////////////////////

// Users online within 15 min
exports.getOnlineUsers = function*() {
  const sql = `
SELECT *
FROM users
WHERE last_online_at > NOW() - interval '15 minutes'
ORDER BY uname
  `;
  return yield queryMany(sql);
};

exports.getMaxTopicId = function*() {
  const result = yield queryOne('SELECT MAX(id) "max_id" FROM topics');
  return result.max_id;
};

exports.getMaxPostId = function*() {
  const result = yield queryOne('SELECT MAX(id) "max_id" FROM posts');
  return result.max_id;
};

exports.getMaxUserId = function*() {
  const result = yield queryOne('SELECT MAX(id) "max_id" FROM users');
  return result.max_id;
};

// https://web.archive.org/web/20131218103719/http://roleplayerguild.com/
const legacyCounts = {
  topics: 210879,
  posts: 9243457,
  users: 44799
};

exports.getStats = function*() {
  let results = yield {
    // I switched the getApproxCount fns out for MaxId fns because
    // the vacuuming threshold was too high and the stats were never getting
    // updated
    topicsCount: exports.getMaxTopicId(), //getApproxCount('topics'),
    usersCount: exports.getMaxUserId(), //getApproxCount('users'),
    postsCount: exports.getMaxPostId(), //getApproxCount('posts'),
    latestUser: exports.getLatestUser(),
    onlineUsers: exports.getOnlineUsers()
  };
  results.topicsCount += legacyCounts.topics;
  results.usersCount += legacyCounts.users;
  results.postsCount += legacyCounts.posts;
  return results;
};

exports.deleteUser = function*(id) {
  const sql = 'DELETE FROM users WHERE id = $1';
  return yield query(sql, [id]);
};

exports.deleteLegacySig = function*(userId) {
  const sql = 'UPDATE users SET legacy_sig = NULL WHERE id = $1';
  return yield query(sql, [userId]);
};

exports.findStaffUsers = function*() {
  const sql = `;
SELECT u.*
FROM users u
WHERE
  u.role IN ('mod', 'smod', 'admin', 'conmod')
  OR 'ARENA_MOD' = ANY (u.roles)
  `;
  return yield queryMany(sql);
};

// Users receive this when someone starts a convo with them
exports.createConvoNotification = wrapOptionalClient(createConvoNotification);
function* createConvoNotification(client, opts) {
  assert(_.isNumber(opts.from_user_id));
  assert(_.isNumber(opts.to_user_id));
  assert(opts.convo_id);

  const sql = `
INSERT INTO notifications (type, from_user_id, to_user_id, convo_id, count)
VALUES ('CONVO', $1, $2, $3, 1)
RETURNING *
  `;

  var result = yield client.queryPromise(sql, [
    opts.from_user_id, opts.to_user_id, opts.convo_id
  ]);
  return result.rows;
}

////////////////////////////////////////////////////////////

// Tries to create a convo notification.
// If to_user_id already has a convo notification for this convo, then
// increment the count
exports.createPmNotification = createPmNotification;
function* createPmNotification(opts) {
  debug('[createPmNotification] opts: ', opts);
  assert(_.isNumber(opts.from_user_id));
  assert(_.isNumber(opts.to_user_id));
  assert(opts.convo_id);
  // Do upsert
  try {
    return yield exports.createConvoNotification({
      from_user_id: opts.from_user_id,
      to_user_id: opts.to_user_id,
      convo_id: opts.convo_id
    });
  } catch(err) {
    // Unique constraint violation
    if (err.code === '23505') {
      const sql = `
        UPDATE notifications
        SET count = COALESCE(count, 0) + 1
        WHERE convo_id = $1 AND to_user_id = $2
      `;
      return yield query(sql, [opts.convo_id, opts.to_user_id]);
    }
    // Else throw if it was a different error
    throw err;
  }
}

// type is 'REPLY_VM' or 'TOPLEVEL_VM'
exports.createVmNotification = function*(data) {
  assert(_.contains(['REPLY_VM', 'TOPLEVEL_VM'], data.type));
  assert(Number.isInteger(data.from_user_id));
  assert(Number.isInteger(data.to_user_id));
  assert(Number.isInteger(data.vm_id));

  const createSql = `
INSERT INTO notifications (type, from_user_id, to_user_id, vm_id, count)
VALUES ($1, $2, $3, $4, 1)
  `;

  const updateSql = `
UPDATE notifications
SET count = count + 1
WHERE vm_id = $1 AND to_user_id = $2
  `;

  return yield withTransaction(function*(client) {
    try {
      yield client.queryPromise(createSql, [data.type, data.from_user_id, data.to_user_id, data.vm_id]);
    } catch(ex) {
      // Unique constraint violation
      if (ex.code === '23505') {
        yield client.queryPromise('ROLLBACK');
        yield client.queryPromise(updateSql, [data.vm_id, data.to_user_id]);
        return;
      }
      throw ex;
    }
  });
};

exports.findParticipantIds = function*(convoId) {
  const sql = `;
    SELECT user_id
    FROM convos_participants
    WHERE convo_id = $1
  `;
  const rows = yield queryMany(sql, [convoId]);
  return _.pluck(rows, 'user_id');
};

exports.findNotificationsForUserId = function*(toUserId) {
  const sql = `
    SELECT *
    FROM notifications
    WHERE to_user_id = $1
  `;
  return yield queryMany(sql, [toUserId]);
};

// Returns how many rows deleted
exports.deleteConvoNotification = function*(toUserId, convoId) {
  const sql = `
    DELETE FROM notifications
    WHERE type = 'CONVO' AND to_user_id = $1 AND convo_id = $2
  `;
  const result = yield query(sql, [toUserId, convoId]);
  return result.rowCount;
};

// Deletes all rows in notifications table for user,
// and also resets the counter caches
exports.clearNotifications = function*(toUserId, notificationIds) {
  assert(Number.isInteger(toUserId));
  assert(Array.isArray(notificationIds));

  const sql1 = `
DELETE FROM notifications
WHERE
  to_user_id = $1
  AND id = ANY ($2::int[])
  `;

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  const sql2 = `
UPDATE users
SET
	notifications_count = sub.notifications_count,
	convo_notifications_count = sub.convo_notifications_count
FROM (
	SELECT
		n.to_user_id,
		COUNT(*) notifications_count,
		COUNT(*) FILTER(WHERE n.type = 'CONVO') convo_notifications_count
	FROM notifications n
	WHERE n.to_user_id = $1
	GROUP BY n.to_user_id
) sub
WHERE users.id = $1
  AND sub.to_user_id = $1
  `;

  yield query(sql1, [toUserId, notificationIds]);
  yield query(sql2, [toUserId]);
};

exports.clearConvoNotifications = function*(toUserId) {
  const sql1 = `
    DELETE FROM notifications
    WHERE to_user_id = $1 AND type = 'CONVO'
  `;

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  const sql2 = `
    UPDATE users
    SET convo_notifications_count = 0
    WHERE id = $1
  `;

  yield query(sql1, [toUserId]);
  yield query(sql2, [toUserId]);
};

// Returns [String]
exports.findAllUnames = function*() {
  const sql = 'SELECT uname FROM users ORDER BY uname';
  const rows = yield queryMany(sql);
  return _.pluck(rows, 'uname');
};

////////////////////////////////////////////////////////////

exports.findRGNTopicForHomepage = function*(topic_id) {
  assert(topic_id);

  const sql = `
SELECT
  t.id,
  t.title,
  t.created_at,
  to_json(u.*) latest_user,
  to_json(p.*) latest_post
FROM topics t
JOIN posts p ON t.latest_post_id = p.id
JOIN users u ON p.user_id = u.id
WHERE t.id = $1
  `;

  return yield queryOne(sql, [topic_id]);
};

////////////////////////////////////////////////////////////

// Keep in sync with findTopicWithHasSubscribed
exports.findTopicById = function*(topicId) {
  assert(topicId);

  const sql = `
SELECT
  t.*,
  to_json(f.*) "forum",
  (SELECT to_json(u2.*) FROM users u2 WHERE u2.id = t.user_id) "user",
  (SELECT json_agg(u3.uname) FROM users u3 WHERE u3.id = ANY (t.co_gm_ids::int[])) co_gm_unames,
  (
   SELECT json_agg(tags.*)
   FROM tags
   JOIN tags_topics ON tags.id = tags_topics.tag_id
   WHERE tags_topics.topic_id = t.id
  ) tags,
  (
    SELECT COALESCE(json_agg(sub.*), '{}'::json)
    FROM (
			SELECT users.uname, arena_outcomes.outcome, u2.uname inserted_by_uname
      FROM arena_outcomes
      JOIN users ON arena_outcomes.user_id = users.id
      JOIN users u2 ON arena_outcomes.inserted_by = u2.id
      WHERE arena_outcomes.topic_id = t.id
    ) sub
  ) arena_outcomes
FROM topics t
JOIN forums f ON t.forum_id = f.id
WHERE t.id = $1
GROUP BY t.id, f.id
  `;

  return yield queryOne(sql, [topicId]);
};

exports.findArenaOutcomesForTopicId = function*(topic_id) {
  assert(_.isNumber(topic_id));

  const sql = `
    SELECT
      arena_outcomes.*,
      to_json(users.*) "user"
    FROM arena_outcomes
    JOIN users ON arena_outcomes.user_id = users.id
    WHERE topic_id = $1
  `;

  return yield queryMany(sql, [topic_id]);
};

// props:
// - title Maybe String
// - join-status Maybe (jump-in | apply | full)
//
exports.updateTopic = function*(topicId, props) {
  assert(topicId);
  assert(props);
  const sql = `
    UPDATE topics
    SET
      title = COALESCE($2, title),
      join_status = COALESCE($3, join_status)::join_status
    WHERE id = $1
    RETURNING *
  `;
  return yield queryOne(sql, [topicId, props.title, props.join_status]);
};

////////////////////////////////////////////////////////////

exports.createMentionNotification = function*(opts) {
  assert(opts.from_user_id);
  assert(opts.to_user_id);
  assert(opts.post_id);
  assert(opts.topic_id);

  const sql = `
    INSERT INTO notifications
    (type, from_user_id, to_user_id, topic_id, post_id)
    VALUES ('MENTION', $1, $2, $3, $4)
    RETURNING *
  `;

  return yield queryOne(sql, [
    opts.from_user_id,
    opts.to_user_id,
    opts.topic_id,
    opts.post_id
  ]);
};

////////////////////////////////////////////////////////////

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

  const sql = `
    INSERT INTO notifications
    (type, from_user_id, to_user_id, topic_id, post_id)
    VALUES ('QUOTE', $1, $2, $3, $4)
    RETURNING *
  `;

  return yield queryOne(sql, [
    opts.from_user_id,  // $1
    opts.to_user_id,  // $2
    opts.topic_id, // $3
    opts.post_id // $4
  ]);
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
  const sql = `
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
  END "post",
  CASE
    WHEN n.vm_id IS NOT NULL
    THEN
      json_build_object (
        'id', n.vm_id,
        'html', vms.html
      )
  END "vm"
FROM notifications n
JOIN users u ON n.from_user_id = u.id
LEFT OUTER JOIN convos c ON n.convo_id = c.id
LEFT OUTER JOIN topics t ON n.topic_id = t.id
LEFT OUTER JOIN posts p ON n.post_id = p.id
LEFT OUTER JOIN vms ON n.vm_id = vms.id
WHERE n.to_user_id = $1
ORDER BY n.id DESC
  `;

  return yield queryMany(sql, [toUserId]);
};

// Returns how many rows deleted
exports.deleteNotificationsForPostId = function*(toUserId, postId) {
  assert(toUserId);
  assert(postId);

  const sql = `
    DELETE FROM notifications
    WHERE to_user_id = $1 AND post_id = $2
  `;

  const result = yield query(sql, [toUserId, postId]);
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
    sql = `
INSERT INTO viewers (uname, forum_id, topic_id, viewed_at)
VALUES ($1, $2, $3, NOW())
    `;
    params = [ctx.currUser.uname, forumId, topicId];
  } else {
    sql = `
INSERT INTO viewers (ip, forum_id, topic_id, viewed_at)
VALUES ($1, $2, $3, NOW())
    `;
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
          sql = `
            UPDATE viewers
            SET forum_id = $2, topic_id = $3, viewed_at = NOW()
            WHERE uname = $1
          `;
        } else {
          sql = `
            UPDATE viewers
            SET forum_id = $2, topic_id = $3, viewed_at = NOW()
            WHERE ip = $1
          `;
        }
        var result = yield query(sql, params);

        // Only return if we actually updated something
        // Else, loop back so we can insert it
        if (result.rowCount > 0)
          return;
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
  const sql = `
SELECT
  f.id "forum_id",
  COUNT(v.*) "viewers_count"
FROM forums f
LEFT OUTER JOIN active_viewers v ON f.id = v.forum_id
GROUP BY f.id
  `;

  const result = yield query(sql);

  let output = {};
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

  const sql = `
DELETE FROM viewers
WHERE viewed_at < NOW() - interval '15 minutes'
  `;

  const result = yield query(sql);
  const count = result.rowCount;
  debug('[clearExpiredViewers] Deleted views: ' + count);
  return count;
};

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
exports.findViewersForTopicId = function*(topicId) {
  assert(topicId);
  var sql = `
SELECT *
FROM active_viewers
WHERE topic_id = $1
ORDER BY uname
  `;

  const viewers = yield queryMany(sql, [topicId]);

  const output = {
    users: _.filter(viewers, 'uname'),
    guests: _.filter(viewers, 'ip')
  };

  return output;
};

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
exports.findViewersForForumId = function*(forumId) {
  assert(forumId);

  var sql = `
SELECT *
FROM active_viewers
WHERE forum_id = $1
ORDER BY uname
  `;
  var viewers = yield queryMany(sql, [forumId]);

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
    sql = `
      UPDATE topics
      SET forum_id = $2, moved_from_forum_id = $3, moved_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    params = [topicId, toForumId, fromForumId];
  } else {
    sql = `
      UPDATE topics
      SET forum_id = $2, moved_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
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
    sql = `
UPDATE forums
SET latest_post_id = $2
WHERE id = $1
    `;
    debug('topic.id: %s, topic.latest_post_id: %s', topic.id, topic.latest_post_id);
    yield query(sql, [topic.forum_id, topic.latest_post_id]);
  }

  // Update fromForum.latest_post_id if it was topic.latest_post_id since
  // we moved the topic out of this forum.
  if (topic.latest_post_id === fromForum.latest_post_id) {
    debug('[moveTopic] Updating fromForum.latest_post_id');
    sql = `
UPDATE forums
SET latest_post_id = (
  SELECT MAX(t.latest_post_id) "latest_post_id"
  FROM topics t
  WHERE t.forum_id = $1
)
WHERE id = $1
    `;
    yield query(sql, [fromForumId]);
  }

  return topic;
};

////////////////////////////////////////////////////////////

// Required props:
// - post_id: Int
// - from_user_id: Int
// - from_user_uname: String
// - to_user_id: Int
// - type: like | laugh | thank
exports.ratePost = function*(props) {
  assert(props.post_id);
  assert(props.from_user_id);
  assert(props.from_user_uname);
  assert(props.to_user_id);
  assert(props.type);

  const sql = `
INSERT INTO ratings (from_user_id, from_user_uname, post_id, type, to_user_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING *
  `;

  return yield queryOne(sql, [
    props.from_user_id,
    props.from_user_uname,
    props.post_id,
    props.type,
    props.to_user_id
  ]);
};

////////////////////////////////////////////////////////////

exports.findLatestRatingForUserId = function*(userId) {
  assert(userId);

  const sql = `
SELECT *
FROM ratings
WHERE from_user_id = $1
ORDER BY created_at DESC
LIMIT 1
  `;

  return yield queryOne(sql, [userId]);
};

////////////////////////////////////////////////////////////

exports.findRatingByFromUserIdAndPostId = function*(from_user_id, post_id) {
  assert(from_user_id);
  assert(post_id);

  const sql = `
SELECT *
FROM ratings
WHERE from_user_id = $1 AND post_id = $2
  `;
  var result = yield query(sql, [from_user_id, post_id]);
  return result.rows[0];
};

exports.deleteRatingByFromUserIdAndPostId = function*(from_user_id, post_id) {
  assert(from_user_id);
  assert(post_id);

  const sql = `
DELETE FROM ratings
WHERE from_user_id = $1 AND post_id = $2
RETURNING *
  `;

  return yield queryOne(sql, [from_user_id, post_id]);
};

exports.deleteLegacyAvatar = function*(userId) {
  const sql = `
UPDATE users
SET legacy_avatar_url = null
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [userId]);
};

exports.deleteAvatar = function*(userId) {
  const sql = `
UPDATE users
SET legacy_avatar_url = null, avatar_url = ''
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [userId]);
};

// User receives this when someone rates their post
// Required props:
// - from_user_id
// - to_user_id
// - post_id
// - topic_id
// - rating_type: Any rating_type enum
// Returns created notification
exports.createRatingNotification = function*(props) {
  assert(props.from_user_id);
  assert(props.to_user_id);
  assert(props.post_id);
  assert(props.topic_id);
  assert(props.rating_type);

  const sql = `
INSERT INTO notifications
(type, from_user_id, to_user_id, meta, post_id, topic_id)
VALUES ('RATING', $1, $2, $3, $4, $5)
RETURNING *
  `;

  return yield queryOne(sql, [
    props.from_user_id, // $1
    props.to_user_id, // $2
    { type: props.rating_type }, // $3
    props.post_id, // $4
    props.topic_id // $5
  ]);
};

// Recalculates forum caches including the counter caches and
// the latest_post_id and latest_post_at
//
// Ignores hidden topics in the recalculation
// Use this to fix a forum when you hide a spambot. Otherwise the spambot
// topic will hang around as the forum's latest post.
exports.refreshForum = function*(forumId) {
  assert(forumId);

  var sql = `
UPDATE forums
SET
  posts_count = sub.posts_count,
  latest_post_id = sub.latest_post_id
FROM (
  SELECT
    SUM(posts_count) posts_count,
    MAX(latest_post_id) latest_post_id
  FROM topics
  WHERE forum_id = $1 AND is_hidden = false
) sub
WHERE id = $1
RETURNING forums.*
  `;

  return yield queryOne(sql, [forumId]);
};

// -> JSONString
exports.findAllUnamesJson = function*() {
  const sql = `
SELECT json_agg(uname) unames
FROM users
--WHERE last_online_at IS NOT NULL
  `;
  const row = yield queryOne(sql);
  return row.unames;
};

exports.updateTopicCoGms = function*(topicId, userIds) {
  assert(topicId);
  assert(_.isArray(userIds));

  const sql = `
UPDATE topics
SET co_gm_ids = $2
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [topicId, userIds]);
};

exports.findAllTags = function*() {
  const sql = `
SELECT *
FROM tags
  `;
  return yield queryMany(sql);
};

// Returns [TagGroup] where each group has [Tag] array bound to `tags` property
exports.findAllTagGroups = function*() {
  const sql = `
SELECT
  *,
  (SELECT json_agg(t.*) FROM tags t WHERE t.tag_group_id = tg.id) tags
FROM tag_groups tg
  `;

  return yield queryMany(sql);
};

// topicId :: String | Int
// tagIds :: [Int]
exports.updateTopicTags = function*(topicId, tagIds) {
  assert(topicId);
  assert(_.isArray(tagIds));

  var sql;
  return yield withTransaction(function*(client) {
    // Delete all tags for this topic from the bridge table
    yield client.queryPromise(`
DELETE FROM tags_topics
WHERE topic_id = $1
    `, [topicId]);

    // Now create the new bridge links
    var thunks = [];
    tagIds.forEach(function(tagId) {
      var thunk = client.queryPromise(`
INSERT INTO tags_topics (topic_id, tag_id)
VALUES ($1, $2)
      `, [topicId, tagId]);

      thunks.push(thunk);
    });

    yield coParallel(thunks, 5);
  });
};

// Example return:
//
//   uname   count   latest_at
//   foo     33      2015-02-27 06:50:18.943-06
//   Mahz    125     2015-03-01 03:32:49.539-06
//
// `latest_post_at` is the timestamp of the latest post by that
// user that has this ip address.
exports.findUsersWithPostsWithIpAddress = function*(ip_address) {
  assert(ip_address);

  const sql = `
SELECT
  u.uname           uname,
  u.slug            slug,
  COUNT(p.id)       count,
  MAX(p.created_at) latest_at
FROM posts p
JOIN users u ON p.user_id = u.id
WHERE p.ip_address = $1
GROUP BY u.uname, u.slug
  `;

  return yield queryMany(sql, [ip_address]);
};

exports.findUsersWithPmsWithIpAddress = function*(ip_address) {
  assert(ip_address);

  const sql = `
SELECT
  u.uname           uname,
  u.slug            slug,
  COUNT(p.id)       count,
  MAX(p.created_at) latest_at
FROM pms p
JOIN users u ON p.user_id = u.id
WHERE p.ip_address = $1
GROUP BY u.uname, u.slug
  `;

  return yield queryMany(sql, [ip_address]);
};

// Returns [String]
exports.findAllIpAddressesForUserId = function*(user_id) {
  assert(user_id);

  const sql = `
SELECT DISTINCT ip_address
FROM posts
WHERE user_id = $1 AND ip_address IS NOT NULL

UNION

SELECT DISTINCT ip_address
FROM pms
WHERE user_id = $1 AND ip_address IS NOT NULL
  `;

  const rows = yield queryMany(sql, [user_id]);
  return _.pluck(rows, 'ip_address');
};

// Returns latest 5 unhidden checks
exports.findLatestChecks = function*() {
  var forumIds = [12, 38, 13, 14, 15, 16, 40, 43];
  var sql = `
SELECT
  t.*,
  (SELECT to_json(u.*) FROM users u WHERE id = t.user_id) "user",
  (
   SELECT json_agg(tags.*)
   FROM tags
   JOIN tags_topics ON tags.id = tags_topics.tag_id
   WHERE tags_topics.topic_id = t.id
  ) tags
FROM topics t
WHERE
  t.forum_id = ANY ($1::int[])
  AND NOT t.is_hidden
ORDER BY t.id DESC
LIMIT 5
  `;

  return yield queryMany(sql, [forumIds]);
};

// Returns latest 5 unhidden roleplays
exports.findLatestRoleplays = function*() {
  var forumIds = [3, 4, 5, 6, 7, 39, 42];
  var sql = `
SELECT
  t.*,
  (SELECT to_json(u.*) FROM users u WHERE id = t.user_id) "user",
  (
   SELECT json_agg(tags.*)
   FROM tags
   JOIN tags_topics ON tags.id = tags_topics.tag_id
   WHERE tags_topics.topic_id = t.id
  ) tags
FROM topics t
WHERE
  t.forum_id = ANY ($1::int[])
  AND NOT t.is_hidden
ORDER BY t.id DESC
LIMIT 5
  `;

  return yield queryMany(sql, [forumIds]);
};

exports.findAllPublicTopicUrls = function*() {
  var sql = `
SELECT id, title
FROM topics
WHERE
  is_hidden = false
  AND forum_id IN (
    SELECT id
    FROM forums
    WHERE category_id NOT IN (4)
  )
  `;

  var result = yield query(sql);
  return result.rows.map(function(row) {
    return pre.presentTopic(row).url;
  });
};

exports.findPostsByIds = function*(ids) {
  assert(_.isArray(ids));
  ids = ids.map(Number);  // Ensure ids are numbers, not strings

  var sql = `
SELECT
  p.*,
  to_json(t.*) topic,
  to_json(f.*) forum,
  to_json(u.*) "user"
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
JOIN users u ON p.user_id = u.id
WHERE p.id = ANY ($1::int[])
  `;

  var rows = yield queryMany(sql, [ids]);

  // Reorder posts by the order of ids passed in
  var out = [];

  ids.forEach(function(id) {
    var row = _.findWhere(rows, { id: id });
    if (row)
      out.push(row);
  });

  return out;
};

////////////////////////////////////////////////////////////

exports.getUnamesMappedToIds = function*() {
  const sql = 'SELECT uname, id FROM users';
  const rows = yield queryMany(sql);

  var out = {};
  rows.forEach(function(row) { out[row.uname.toLowerCase()] = row.id; });

  return out;
};

////////////////////////////////////////////////////////////

// Trophies are returned newly-awarded first
exports.findTrophiesForUserId = function*(user_id) {
  const sql = `
SELECT
  tu.is_anon,
  t.*,
  tu.awarded_at,
  tu.message_markup,
  tu.message_html,
  tu.n,
  tu.id trophies_users_id,
  to_json(u1.*) awarded_by,
  to_json(tg.*) "group"
FROM trophies t
JOIN trophies_users tu ON t.id = tu.trophy_id
LEFT OUTER JOIN users u1 ON tu.awarded_by = u1.id
LEFT OUTER JOIN trophy_groups tg ON t.group_id = tg.id
WHERE tu.user_id = $1
ORDER BY tu.awarded_at DESC
  `;

  return yield queryMany(sql, [user_id]);
};

////////////////////////////////////////////////////////////

// Finds one trophy
exports.findTrophyById = function*(trophy_id) {
  const sql = `
SELECT
  t.*,
  to_json(tg.*) "group"
FROM trophies t
LEFT OUTER JOIN trophy_groups tg ON t.group_id = tg.id
WHERE t.id = $1
GROUP BY t.id, tg.id
  `;

  return yield queryOne(sql, [trophy_id]);
};

////////////////////////////////////////////////////////////

exports.findTrophiesByGroupId = function*(group_id) {
  const sql = `
SELECT *
FROM trophies t
WHERE t.group_id = $1
ORDER BY t.id ASC
  `;

  return yield queryMany(sql, [group_id]);
};

////////////////////////////////////////////////////////////

exports.findTrophyGroups = function*() {
  const sql = `
SELECT *
FROM trophy_groups
ORDER BY id DESC
  `;

  return yield queryMany(sql);
};

////////////////////////////////////////////////////////////

exports.findTrophyGroupById = function*(group_id) {
  const sql = `
SELECT *
FROM trophy_groups tg
WHERE tg.id = $1
  `;

  return yield queryOne(sql, [group_id]);
};

////////////////////////////////////////////////////////////

// title Required
// description_markup Optional
// description_html Optional
exports.updateTrophyGroup = function*(id, title, desc_markup, desc_html) {
  const sql = `
UPDATE trophy_groups
SET
  title = $2,
  description_markup = $3,
  description_html = $4
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [id, title, desc_markup, desc_html]);
};

////////////////////////////////////////////////////////////

// Update individual trophy
//
// title Required
// description_markup Optional
// description_html Optional
exports.updateTrophy = function*(id, title, desc_markup, desc_html) {
  assert(Number.isInteger(id));

  const sql = `
UPDATE trophies
SET
  title = $2,
  description_markup = $3,
  description_html = $4
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [id, title, desc_markup, desc_html]);
};

////////////////////////////////////////////////////////////

// Update trophy<->user bridge record
//
// message_markup Optional
// message_html Optional
exports.updateTrophyUserBridge = function*(id, message_markup, message_html) {
  assert(Number.isInteger(id));

  const sql = `
UPDATE trophies_users
SET
  message_markup = $2,
  message_html = $3
WHERE id = $1
RETURNING *
  `;

  return yield queryOne(sql, [id, message_markup, message_html]);
};

////////////////////////////////////////////////////////////

exports.deactivateCurrentTrophyForUserId = function*(user_id) {
  assert(_.isNumber(user_id));

  const sql = `
UPDATE users
SET active_trophy_id = NULL
WHERE id = $1
  `;

  yield queryOne(sql, [user_id]);
};

////////////////////////////////////////////////////////////

exports.updateUserActiveTrophyId = function*(user_id, trophy_id) {
  assert(_.isNumber(user_id));
  assert(_.isNumber(trophy_id));

  const sql = `
UPDATE users
SET active_trophy_id = $2
WHERE id = $1
  `;

  return yield queryOne(sql, [user_id, trophy_id]);
};

////////////////////////////////////////////////////////////

exports.findTrophyUserBridgeById = function*(id) {
  debug('[findTrophyUserBridgeById] id=%j', id);
  assert(id);

  const sql = `
SELECT
  tu.*,
  to_json(t.*) AS trophy,
  to_json(u.*) AS user
FROM trophies_users tu
JOIN trophies t ON tu.trophy_id = t.id
JOIN users u ON tu.user_id = u.id
WHERE tu.id = $1
  `;

  return yield queryOne(sql, [id]);
};

////////////////////////////////////////////////////////////

// Deprecated now that I've added a primary key serial to trophies_users.
//
// Instead, use db.findTrophyUserBridgeById(id)
exports.findTrophyByIdAndUserId = function*(trophy_id, user_id) {
  assert(_.isNumber(user_id));
  assert(_.isNumber(trophy_id));

  const sql = `
SELECT trophies.*
FROM trophies_users
JOIN trophies ON trophies_users.trophy_id = trophies.id
WHERE trophies_users.trophy_id = $1 AND trophies_users.user_id = $2
LIMIT 1
  `;

  return yield queryOne(sql, [trophy_id, user_id]);
};

////////////////////////////////////////////////////////////

exports.findWinnersForTrophyId = function*(trophy_id) {
  const sql = `
SELECT
  tu.is_anon,
  winners.id,
  winners.uname,
  winners.slug,
  tu.awarded_at,
  tu.message_markup,
  tu.message_html,
  tu.id AS trophies_users_id,
  to_json(awarders.*) "awarded_by"
FROM trophies_users tu
JOIN users winners ON tu.user_id = winners.id
LEFT OUTER JOIN users awarders ON tu.awarded_by = awarders.id
WHERE tu.trophy_id = $1
  `;

  return yield queryMany(sql, [trophy_id]);
};

////////////////////////////////////////////////////////////

// description_markup and _html are optional
//
// Returns created trophy group
exports.createTrophyGroup = function*(title, description_markup, description_html) {
  assert(_.isString(title));
  assert(_.isUndefined(description_markup) || _.isString(description_markup));
  assert(_.isUndefined(description_html) || _.isString(description_html));

  const sql = `
INSERT INTO trophy_groups (title, description_markup, description_html)
VALUES ($1, $2, $3)
RETURNING *
  `;

  return yield queryOne(sql, [
    title,
    description_markup,
    description_html
  ]);
};

////////////////////////////////////////////////////////////

// props must have user_id (Int), text (String), html (String) properties
exports.createStatus = function*(props) {
  assert(Number.isInteger(props.user_id));
  assert(typeof props.text === 'string');
  assert(typeof props.html === 'string');

  const sql = `
INSERT INTO statuses (user_id, text, html)
VALUES ($1, $2, $3)
RETURNING *
  `;

  return yield queryOne(sql, [props.user_id, props.text, props.html]);
};

////////////////////////////////////////////////////////////

exports.findLatestStatusesForUserId = function*(user_id) {
  const sql = `
SELECT *
FROM statuses
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 5
  `;

  return yield queryMany(sql, [user_id]);
};

////////////////////////////////////////////////////////////

exports.findStatusById = function*(id) {
  const sql = `
SELECT
  us.*,
  to_json(u.*) "user"
FROM statuses us
JOIN users u ON us.user_id = u.id
WHERE us.id = $1
  `;

  return yield queryOne(sql, [id]);
};

////////////////////////////////////////////////////////////

exports.deleteStatusById = function*(id) {
  const sql = `
DELETE FROM statuses
WHERE id = $1
  `;

  yield query(sql, [id]);
};

////////////////////////////////////////////////////////////

exports.findLatestStatuses = function*() {
  const sql = `
SELECT
  us.*,
  to_json(u.*) "user"
FROM statuses us
JOIN users u ON us.user_id = u.id
ORDER BY created_at DESC
LIMIT 5
  `;

  return yield queryMany(sql);
};

////////////////////////////////////////////////////////////

exports.clearCurrentStatusForUserId = function*(user_id) {
  assert(user_id);

  const sql = `
UPDATE users
SET current_status_id = NULL
WHERE id = $1
  `;

  yield query(sql, [user_id]);
};

////////////////////////////////////////////////////////////

exports.findAllStatuses = function*() {
  const sql = `
SELECT
  s.*,
  to_json(u.*) "user",
  json_agg(likers.uname) "likers"
FROM statuses s
JOIN users u ON s.user_id = u.id
LEFT OUTER JOIN status_likes ON s.id = status_likes.status_id
LEFT OUTER JOIN users likers ON status_likes.user_id = likers.id
GROUP BY s.id, u.id
ORDER BY s.created_at DESC
LIMIT 100
  `;

  const result = yield query(sql, []);
  const statuses = result.rows.map(function(r) {
    r.likers = r.likers.filter(Boolean);
    return r;
  });

  return statuses;
};

exports.likeStatus = function*(props) {
  assert(props.user_id);
  assert(props.status_id);

  yield withTransaction(function*(client) {

    // 1. Create status_likes row

    yield client.queryPromise(`
INSERT INTO status_likes (status_id, user_id)
VALUES ($1, $2)
    `, [
      props.status_id,
      props.user_id
    ]);

    // 2. Update status

    yield client.queryPromise(`
UPDATE statuses
SET liked_user_ids = array_append(liked_user_ids, $2)
WHERE id = $1
    `, [
      props.status_id,
      props.user_id
    ]);
  });
};

////////////////////////////////////////////////////////////

// Returns created_at Date OR null for user_id
exports.latestStatusLikeAt = function*(user_id) {
  assert(user_id);

  const sql = `
SELECT MAX(created_at) created_at
FROM status_likes
WHERE user_id = $1
  `;

  const row = yield queryOne(sql, [user_id]);

  return row && row.created_at;
};

////////////////////////////////////////////////////////////

exports.updateTopicWatermark = function*(props) {
  debug('[updateTopicWatermark] props:', props);
  assert(props.topic_id);
  assert(props.user_id);
  assert(props.post_type);
  assert(props.post_id);

  try {
    yield query(`
INSERT INTO topics_users_watermark (topic_id, user_id, post_type, watermark_post_id)
VALUES ($1, $2, $3, $4)
    `, [
      props.topic_id,
      props.user_id,
      props.post_type,
      props.post_id
    ]);
  } catch(ex) {
    // If unique violation...
    if (ex.code === '23505') {
      yield query(`
UPDATE topics_users_watermark
SET watermark_post_id = GREATEST(watermark_post_id, $4)
WHERE topic_id = $1 AND user_id = $2 AND post_type = $3
      `, [
        props.topic_id,
        props.user_id,
        props.post_type,
        props.post_id
      ]);
      return;
    }
    throw ex;
  }
};

////////////////////////////////////////////////////////////

exports.findFirstUnreadPostId = function*(props) {
  assert(props.topic_id);
  assert(props.post_type);

  const sql = `
SELECT COALESCE(
  MIN(p.id),
  (
    SELECT MIN(p2.id)
    FROM posts p2
    WHERE p2.topic_id = $1
      AND p2.type = $3
      AND p2.is_hidden = false
  )
) post_id
FROM posts p
WHERE
  p.id > (
    SELECT w.watermark_post_id
    FROM topics_users_watermark w
    WHERE w.topic_id = $1
      AND w.user_id = $2
      AND w.post_type = $3
  )
  AND p.topic_id = $1
  AND p.type = $3
  AND p.is_hidden = false
  `;

  const row = yield queryOne(sql, [
    props.topic_id,
    props.user_id,
    props.post_type
  ]);

  return row && row.post_id;
};

////////////////////////////////////////////////////////////

exports.findFirstUnreadPostId = function*(props) {
  assert(props.topic_id);
  assert(props.post_type);

  const sql = `
SELECT COALESCE(MIN(p.id),
  CASE $3::post_type
    WHEN 'ic' THEN
      (SELECT t.latest_ic_post_id FROM topics t WHERE t.id = $1)
    WHEN 'ooc' THEN
      (SELECT COALESCE(t.latest_ooc_post_id, t.latest_post_id) FROM topics t WHERE t.id = $1)
    WHEN 'char' THEN
      (SELECT t.latest_char_post_id FROM topics t WHERE t.id = $1)
  END
) post_id
FROM posts p
WHERE
  p.id > COALESCE(
    (
      SELECT w.watermark_post_id
      FROM topics_users_watermark w
      WHERE w.topic_id = $1
        AND w.user_id = $2
        AND w.post_type = $3
    ),
    0
  )
  AND p.topic_id = $1
  AND p.type = $3
  `;

  const row = yield queryOne(sql, [
    props.topic_id,
    props.user_id,
    props.post_type
  ]);

  return row && row.post_id;
};

exports.deleteNotificationForUserIdAndId = function*(userId, id) {
  const sql = `
DELETE FROM notifications
WHERE to_user_id = $1
  AND id = $2
  `;

  yield query(sql, [userId, id]);
};

exports.findNotificationById = function*(id) {
  const sql = `
SELECT *
FROM notifications
WHERE id = $1
  `;

  return yield queryOne(sql, [id]);
};

////////////////////////////////////////////////////////////

// - inserted_by is user_id of ARENA_MOD that is adding this outcome
exports.createArenaOutcome = function*(topic_id, user_id, outcome, inserted_by) {
  assert(_.isNumber(topic_id));
  assert(_.isNumber(user_id));
  assert(_.contains(['WIN', 'LOSS', 'DRAW'], outcome));
  assert(_.isNumber(inserted_by));

  const sql = `
INSERT INTO arena_outcomes (topic_id, user_id, outcome, profit, inserted_by)
VALUES ($1, $2, $3, $4, $5)
RETURNING *
  `;

  var profit;
  switch(outcome) {
  case 'WIN':
    profit = 100;
    break;
  case 'DRAW':
    profit = 50;
    break;
  case 'LOSS':
    profit = 0;
    break;
  default:
    throw new Error('Unhandled outcome: ' + outcome);
  }

  return yield queryOne(sql, [topic_id, user_id, outcome, profit, inserted_by]);
};

////////////////////////////////////////////////////////////

exports.deleteArenaOutcome = function*(topic_id, outcome_id) {
  assert(_.isNumber(topic_id));
  assert(_.isNumber(outcome_id));

  const sql = `
DELETE FROM arena_outcomes
WHERE topic_id = $1 and id = $2
  `;

  return yield query(sql, [topic_id, outcome_id]);
};

////////////////////////////////////////////////////////////

// Query is more complex than necessary to make it idempotent
exports.promoteArenaRoleplayToRanked = function*(topic_id) {
  assert(_.isNumber(topic_id));

  const sql = `
UPDATE topics
SET is_ranked = true
WHERE
  id = $1
  AND is_ranked = false
  AND EXISTS (
    SELECT 1
    FROM forums
    WHERE
      is_arena_rp = true
      AND id = (SELECT forum_id FROM topics WHERE id = $1)
  )
RETURNING *
  `;

  return yield queryMany(sql, [topic_id]);
};

// Returns the current feedback topic only if:
// - User has not already replied to it (or clicked ignore)
exports.findUnackedFeedbackTopic = function*(feedback_topic_id, user_id) {
  assert(_.isNumber(feedback_topic_id));
  assert(_.isNumber(user_id));

  const sql = `
SELECT *
FROM feedback_topics
WHERE
  id = $1
  AND NOT EXISTS (
    SELECT 1
    FROM feedback_replies fr
    WHERE fr.feedback_topic_id = $1 AND fr.user_id = $2
  )
  `;

  return yield queryOne(sql, [feedback_topic_id, user_id]);
};

////////////////////////////////////////////////////////////

exports.findFeedbackTopicById = function*(ftopic_id) {
  assert(_.isNumber(ftopic_id));

  const sql = `
SELECT feedback_topics.*
FROM feedback_topics
WHERE id = $1
  `;

  return yield queryOne(sql, [ftopic_id]);
};

////////////////////////////////////////////////////////////

exports.findFeedbackRepliesByTopicId = function*(ftopic_id) {
  assert(_.isNumber(ftopic_id));

  const sql = `
SELECT
  fr.*,
  u.uname
FROM feedback_replies fr
JOIN users u ON fr.user_id = u.id
WHERE fr.feedback_topic_id = $1
ORDER BY id DESC
  `;

  return yield queryMany(sql, [ftopic_id]);
};

////////////////////////////////////////////////////////////

exports.insertReplyToUnackedFeedbackTopic = function*(feedback_topic_id, user_id, text, ignored) {
  assert(_.isNumber(feedback_topic_id));
  assert(_.isNumber(user_id));
  assert(_.isBoolean(ignored));

  const sql = `
INSERT INTO feedback_replies (user_id, ignored, text, feedback_topic_id)
VALUES ($1, $2, $3, $4)
RETURNING *
  `;

  return yield queryOne(sql, [user_id, ignored, text, feedback_topic_id]);
};

////////////////////////////////////////////////////////////

// Defaults to the most active 10 friends
exports.findFriendshipsForUserId = function*(user_id, limit) {
  assert(_.isNumber(user_id));

  const sql = `
SELECT
  friendships.*,
  json_build_object(
    'uname', u1.uname,
    'last_online_at', u1.last_online_at,
    'avatar_url', u1.avatar_url,
    'slug', u1.slug
  ) "to_user"
FROM friendships
JOIN users u1 ON friendships.to_user_id = u1.id
WHERE from_user_id = $1
ORDER BY u1.last_online_at DESC NULLS LAST
LIMIT $2
  `;

  return yield queryMany(sql, [user_id, limit || 100]);
};

exports.findFriendshipBetween = function*(from_id, to_id) {
  const sql = `
SELECT friendships
FROM friendships
WHERE from_user_id = $1 AND to_user_id = $2
  `;

  return yield queryOne(sql, [from_id, to_id]);
};

////////////////////////////////////////////////////////////

exports.createFriendship = function*(from_id, to_id) {
  assert(_.isNumber(from_id));
  assert(_.isNumber(to_id));

  const sql = `
INSERT INTO friendships (from_user_id, to_user_id)
VALUES ($1, $2)
  `;

  return yield query(sql, [from_id, to_id]);
};

exports.deleteFriendship = function*(from_id, to_id) {
  assert(_.isNumber(from_id));
  assert(_.isNumber(to_id));

  const sql = `
DELETE FROM friendships
WHERE from_user_id = $1 AND to_user_id = $2
  `;

  return yield query(sql, [from_id, to_id]);
};

////////////////////////////////////////////////////////////

exports.getAllChatMessages = function*() {
  const sql = `
SELECT
  chat_messages.*,
  to_json(u.*) "user"
FROM chat_messages
LEFT OUTER JOIN users u ON chat_messages.user_id = u.id
ORDER BY id ASC
  `;

  return yield queryMany(sql);
};

////////////////////////////////////////////////////////////

// Returns [{when: '2015-7-25', count: 64}, ...]
exports.getChatLogDays = function*() {
  const sql = `
SELECT to_char(sub.day, 'YYYY-MM-DD') "when", sub.count "count"
FROM (
	SELECT date_trunc('day', cm.created_at) "day", COUNT(cm.*) "count"
	FROM chat_messages cm
	GROUP BY "day"
	ORDER BY "day"
) sub
  `;

  return yield queryMany(sql);
};

////////////////////////////////////////////////////////////

// `when` is string 'YYYY-MM-DD'
exports.findLogByDateTrunc = function*(when) {
  assert(_.isString(when));

  const sql = `
SELECT sub.*
FROM (
	SELECT
		to_char(date_trunc('day', cm.created_at), 'YYYY-MM-DD') "when",
		cm.*,
    u.uname "uname"
	FROM chat_messages cm
  LEFT OUTER JOIN users u ON cm.user_id = u.id
) sub
WHERE sub.when = $1
ORDER BY sub.id
  `;

  return yield queryMany(sql, [when]);
};

// data:
// - to_user_id: Int
// - from_user_id: Int
// - markup
// - html
// Optional
// - parent_vm_id: Int - Only present if this VM is a reply to a toplevel VM
exports.createVm = function*(data) {
  assert(Number.isInteger(data.from_user_id));
  assert(Number.isInteger(data.to_user_id));
  assert(_.isString(data.markup));
  assert(_.isString(data.html));

  const sql = `
INSERT INTO vms (from_user_id, to_user_id, markup, html, parent_vm_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING *
  `;

  return yield queryOne(sql, [
    data.from_user_id,
    data.to_user_id,
    data.markup,
    data.html,
    data.parent_vm_id
  ]);
};

exports.findLatestVMsForUserId = function*(user_id) {
  assert(Number.isInteger(user_id));

  const sql = `
SELECT
  vms.*,
  json_build_object(
    'uname', u.uname,
    'slug', u.slug,
    'avatar_url', u.avatar_url
  ) "from_user",
  (
    SELECT COALESCE(json_agg(sub.*), '[]'::json)
    FROM (
      SELECT
        vms2.*,
        json_build_object(
          'uname', u2.uname,
          'slug', u2.slug,
          'avatar_url', u2.avatar_url,
          'url', '/users/' || u2.slug
        ) "from_user"
      FROM vms vms2
      JOIN users u2 ON vms2.from_user_id = u2.id
      WHERE vms2.parent_vm_id = vms.id
    ) sub
  ) child_vms
FROM vms
JOIN users u ON vms.from_user_id = u.id
WHERE vms.to_user_id = $1 AND parent_vm_id IS NULL
ORDER BY vms.id DESC
LIMIT 30
  `;

  return yield queryMany(sql, [user_id]);
};

exports.clearVmNotification = function*(to_user_id, vm_id) {
  assert(Number.isInteger(to_user_id));
  assert(Number.isInteger(vm_id));

  const sql = `
DELETE FROM notifications
WHERE to_user_id = $1 AND vm_id = $2
  `;

  yield query(sql, [to_user_id, vm_id]);
};

////////////////////////////////////////////////////////////
// current_sidebar_contests

exports.clearCurrentSidebarContest = function*() {
  const sql = `
    UPDATE current_sidebar_contests
    SET is_current = false
  `;

  return yield query(sql);
};

exports.updateCurrentSidebarContest = function*(id, data) {
  assert(Number.isInteger(id));
  assert(_.isString(data.title) || _.isUndefined(data.title));
  assert(_.isString(data.topic_url) || _.isUndefined(data.topic_url));
  assert(_.isString(data.deadline) || _.isUndefined(data.deadline));
  assert(_.isString(data.image_url) || _.isUndefined(data.image_url));
  assert(_.isString(data.description) || _.isUndefined(data.description));
  assert(_.isBoolean(data.is_current) || _.isUndefined(data.is_current));

  // Reminder: Only COALESCE things that are not nullable
  const sql = `
    UPDATE current_sidebar_contests
    SET
      title       = COALESCE($2, title),
      topic_url   = COALESCE($3, topic_url),
      deadline    = COALESCE($4, deadline),
      image_url   = $5,
      description = $6,
      is_current  = COALESCE($7, is_current)
    WHERE id = $1
    RETURNING *
  `;

  return yield queryOne(sql, [
    id, data.title, data.topic_url, data.deadline,
    data.image_url, data.description, data.is_current
  ]);
};

exports.insertCurrentSidebarContest = function*(data) {
  assert(_.isString(data.title));
  assert(_.isString(data.topic_url));
  assert(_.isString(data.deadline));
  assert(_.isString(data.image_url) || _.isUndefined(data.image_url));
  assert(_.isString(data.description) || _.isUndefined(data.description));

  const sql = `
    INSERT INTO current_sidebar_contests
    (title, topic_url, deadline, image_url, description, is_current)
    VALUES
    ($1, $2, $3, $4, $5, true)
    RETURNING *
  `;

  return yield queryOne(sql, [
    data.title, data.topic_url, data.deadline, data.image_url,
    data.description
  ]);
};

// Returns object or undefined
exports.getCurrentSidebarContest = function*() {
  const sql = `
    SELECT *
    FROM current_sidebar_contests
    WHERE is_current = true
    ORDER BY id DESC
    LIMIT 1
  `;

  return yield queryOne(sql);
};

// Grabs info necessary to show the table on /arena-fighters
//
// TODO: Replace getminileaderboard with this, just
// pass in a limit
exports.getArenaLeaderboard = function*(limit) {
  limit = limit || 1000;
  assert(Number.isInteger(limit));

  const sql = `
SELECT
  uname,
  slug,
  arena_wins,
  arena_losses,
  arena_draws,
  arena_points
FROM users
WHERE (arena_wins > 0 OR arena_losses > 0 OR arena_draws > 0)
  AND show_arena_stats = true
ORDER BY
  arena_points DESC,
  arena_wins DESC,
  arena_losses ASC,
  arena_draws DESC
LIMIT $1
  `;

  return yield queryMany(sql, [limit]);
};


////////////////////////////////////////////////////////////

exports.updateConvoFolder = function*(userId, convoId, folder) {
  assert(Number.isInteger(userId));
  assert(convoId);
  assert(_.isString(folder));

  const sql = `
UPDATE convos_participants
SET folder = $3
WHERE user_id = $1
  AND convo_id = $2
  `;

  return yield query(sql, [userId, convoId, folder]);
};

////////////////////////////////////////////////////////////

exports.getConvoFolderCounts = function*(userId) {
  assert(Number.isInteger(userId));

  const sql = `
SELECT
  COUNT(*) FILTER (WHERE folder = 'INBOX') "inbox_count",
  COUNT(*) FILTER (WHERE folder = 'STAR') "star_count",
  COUNT(*) FILTER (WHERE folder = 'ARCHIVE') "archive_count",
  COUNT(*) FILTER (WHERE folder = 'TRASH') "trash_count"
FROM convos_participants
WHERE user_id = $1
  `;

  return yield queryOne(sql, [userId]);
};

////////////////////////////////////////////////////////////
// NUKING
////////////////////////////////////////////////////////////

// In one fell motion, bans a user, hides all their stuff.
//
// Takes an object to prevent mistakes.
// { spambot: UserId, nuker: UserId  }
exports.nukeUser = function * (opts) {
  assert(Number.isInteger(opts.spambot));
  assert(Number.isInteger(opts.nuker));
  const sql = {
    banUser: `
      UPDATE users
      SET role = 'banned'
        , is_nuked = true
        , bio_markup = NULL
        , bio_html = NULL
        , avatar_url = ''
        , sig_html = ''
        , sig = ''
        , custom_title = ''
      WHERE id = $1
    `,
    hideTopics: `UPDATE topics SET is_hidden = true WHERE user_id = $1`,
    hidePosts: `UPDATE posts SET is_hidden = true WHERE user_id = $1`,
    insertNukelist: `
      INSERT INTO nuked_users (user_id, nuker_id)
      VALUES ($1, $2)
    `,
    deleteVms: `DELETE FROM vms WHERE from_user_id = $1`

  };
  return yield withTransaction(function * (client) {
    yield client.queryPromise(sql.banUser, [opts.spambot]);
    yield client.queryPromise(sql.hideTopics, [opts.spambot]);
    yield client.queryPromise(sql.hidePosts, [opts.spambot]);
    yield client.queryPromise(sql.insertNukelist, [opts.spambot, opts.nuker]);
    yield client.queryPromise(sql.deleteVms, [opts.spambot]);
  });
};


// Re-exports

exports.keyvals = require('./keyvals');
exports.ratelimits = require('./ratelimits');
exports.images = require('./images');
exports.dice = require('./dice');
exports.profileViews = require('./profile-views');
