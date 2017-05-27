'use strict';
/*jshint -W002 */
// Node deps
const path = require('path')
const util = require('util')
// 3rd party
const _ = require('lodash')
const assert = require('better-assert')
const debug = require('debug')('app:db')
const pgArray = require('postgres-array')
const promiseMap = require('promise.map')
const genUuid = require('uuid')
// 1st party
const config = require('../config')
const belt = require('../belt')
const pre = require('../presenters')
const {pool} = require('./util')
const {sql} = require('pg-extra')

// If a client is not provided to fn as first argument,
// we'll pass one into it.
/* function wrapOptionalClient(fn) {
 *   return function*() {
 *     var args = Array.prototype.slice.call(arguments, 0);
 *     if (belt.isDBClient(args[0])) {
 *       return yield fn.apply(null, args);
 *     } else {
 *       return yield withTransaction(function*(client) {
 *         return yield fn.apply(null, [client].concat(args));
 *       });
 *     }
 *   };
 * }
 * */

function wrapOptionalClient (fn) {
  return async function () {
    const args = Array.prototype.slice.call(arguments, 0)
    if (belt.isDBClient(args[0])) {
      return fn.apply(null, args)
    } else {
      return pool.withTransaction(async (client) => {
        return fn.apply(null, [client, ...args])
      })
    }
  }
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

exports.updatePostStatus = async function (postId, status) {
  const STATUS_WHITELIST = ['hide', 'unhide']
  assert(STATUS_WHITELIST.includes(status))

  let isHidden
  switch(status) {
    case 'hide':
      isHidden = true
      break
    case 'unhide':
      isHidden = false
      break
    default:
      throw new Error('Invalid status ' + status)
  }

  return pool.one(sql`
    UPDATE posts
    SET is_hidden = ${isHidden}
    WHERE id = ${postId}
    RETURNING *
  `)
}

exports.updateTopicStatus = async function (topicId, status) {
  const STATUS_WHITELIST = ['stick', 'unstick', 'hide', 'unhide', 'close', 'open']
  assert(STATUS_WHITELIST.includes(status))

  let a
  let b
  let c

  switch(status) {
    case 'stick':   [a,b,c] = [true,  null,  null]; break
    case 'unstick': [a,b,c] = [false, null,  null]; break
    case 'hide':    [a,b,c] = [null,  true,  null]; break
    case 'unhide':  [a,b,c] = [null,  false, null]; break
    case 'close':   [a,b,c] = [null,  null,  true]; break
    case 'open':    [a,b,c] = [null,  null,  false]; break
    default: throw new Error('Invalid status ' + status)
  }

  return pool.one(sql`
    UPDATE topics
    SET is_sticky = COALESCE(${a}, is_sticky),
        is_hidden = COALESCE(${b}, is_hidden),
        is_closed = COALESCE(${c}, is_closed)
    WHERE id = ${topicId}
    RETURNING *
  `)
}

// Same as findTopic but takes a userid so that it can return a topic
// with an is_subscribed boolean for the user
// Keep in sync with db.findTopicById
exports.findTopicWithIsSubscribed = async function (userId, topicId) {
  debug('[findTopicWithIsSubscribed] userId %s, topicId %s:', userId, topicId)

  return pool.one(sql`
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
                  WHERE w.topic_id = t.id AND w.post_type = 'ic' AND w.user_id = ${userId}
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
                  WHERE w.topic_id = t.id AND w.post_type = 'ooc' AND w.user_id = ${userId}
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
                  WHERE w.topic_id = t.id AND w.post_type = 'char' AND w.user_id = ${userId}
                ),
                true
              )
            )
        END
      ) unread_char,
      t.*,
      to_json(f.*) "forum",
      array_agg(${userId}::int) @> Array[ts.user_id::int] "is_subscribed",
      (SELECT to_json(u2.*) FROM users u2 WHERE u2.id = t.user_id) "user",
      (SELECT json_agg(u3.uname) FROM users u3 WHERE u3.id = ANY (t.co_gm_ids::int[])) co_gm_unames,
      (SELECT json_agg(tb.banned_id) FROM topic_bans tb WHERE tb.topic_id = t.id) banned_ids,
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
    LEFT OUTER JOIN topic_subscriptions ts ON t.id = ts.topic_id AND ts.user_id = ${userId}
    WHERE t.id = ${topicId}
    GROUP BY t.id, f.id, ts.user_id
  `)
};

////////////////////////////////////////////////////////////

exports.updateUserBio = async function (userId, bioMarkup, bioHtml) {
  assert(_.isString(bioMarkup))

  return pool.one(sql`
    UPDATE users
    SET bio_markup = ${bioMarkup}, bio_html = ${bioHtml}
    WHERE id = ${userId}
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

exports.findTopic = async function (topicId) {
  return pool.one(sql`
    SELECT
      t.*,
      to_json(f.*) "forum"
    FROM topics t
    JOIN forums f ON t.forum_id = f.id
    WHERE t.id = ${topicId}
  `)
}

////////////////////////////////////////////////////////////

exports.deleteResetTokens = async function (userId) {
  assert(_.isNumber(userId))

  return pool.query(sql`
    DELETE FROM reset_tokens
    WHERE user_id = ${userId}
  `)
}

////////////////////////////////////////////////////////////

exports.findLatestActiveResetToken = async function (userId) {
  assert(_.isNumber(userId))

  return pool.one(sql`
    SELECT *
    FROM active_reset_tokens
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 1
  `)
}

////////////////////////////////////////////////////////////

exports.createResetToken = async function (userId) {
  debug('[createResetToken] userId: ' + userId)

  const uuid = genUuid.v4()

  return pool.one(sql`
    INSERT INTO reset_tokens (user_id, token)
    VALUES (${userId}, ${uuid})
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

exports.findUserById = exports.findUser = async function (id) {
  return pool.one(sql`
    SELECT * FROM users WHERE id = ${id}
  `)
}

////////////////////////////////////////////////////////////

exports.findUserBySlug = exports.getUserBySlug = async function (slug) {
  assert(_.isString(slug))

  return pool.one(sql`
    SELECT u.*
    FROM users u
    WHERE u.slug = lower(${slug})
    GROUP BY u.id
  `)
}

////////////////////////////////////////////////////////////

// Only use this if you need ratings table, else use just findUserBySlug
exports.findUserWithRatingsBySlug = async function (slug) {
  assert(_.isString(slug))

  return pool.one(sql`
    WITH q1 AS (
      SELECT
        COUNT(r) FILTER (WHERE r.type = 'like') like_count,
        COUNT(r) FILTER (WHERE r.type = 'laugh') laugh_count,
        COUNT(r) FILTER (WHERE r.type = 'thank') thank_count
      FROM ratings r
      JOIN users u ON r.to_user_id = u.id
      WHERE u.slug = lower(${slug})
      GROUP BY r.to_user_id
    ),
    q2 AS (
      SELECT
        COUNT(r) FILTER (WHERE r.type = 'like') like_count,
        COUNT(r) FILTER (WHERE r.type = 'laugh') laugh_count,
        COUNT(r) FILTER (WHERE r.type = 'thank') thank_count
      FROM ratings r
      JOIN users u ON r.from_user_id = u.id
      WHERE u.slug = lower(${slug})
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
    WHERE u.slug = lower(${slug})
    GROUP BY u.id
  `)
}

////////////////////////////////////////////////////////////

exports.findUserByUnameOrEmail = async function (unameOrEmail) {
  assert(_.isString(unameOrEmail))

  return pool.one(sql`
    SELECT *
    FROM users u
    WHERE lower(u.uname) = lower(${unameOrEmail})
       OR lower(u.email) = lower(${unameOrEmail})
  `)
}

////////////////////////////////////////////////////////////

// Note: Case-insensitive
exports.findUserByEmail = async function (email) {
  debug('[findUserByEmail] email: ' + email)

  return pool.one(sql`
    SELECT *
    FROM users u
    WHERE lower(u.email) = lower(${email});
  `)
};

////////////////////////////////////////////////////////////

// Note: Case-insensitive
exports.findUserByUname = async function (uname) {
  debug('[findUserByUname] uname: ' + uname)

  return pool.one(sql`
    SELECT *
    FROM users u
    WHERE lower(u.uname) = lower(${uname});
  `)
};

////////////////////////////////////////////////////////////

// `beforeId` is undefined or a number
exports.findRecentPostsForUserId = async function (userId, beforeId) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId))

  return pool.many(sql`
    SELECT
      p.*,
      to_json(t.*) "topic",
      to_json(f.*) "forum"
    FROM posts p
    JOIN topics t ON p.topic_id = t.id
    JOIN forums f ON t.forum_id = f.id
    WHERE p.user_id = ${userId} AND p.id < ${beforeId || 1e9}
    ORDER BY p.id DESC
    LIMIT ${config.RECENT_POSTS_PER_PAGE}
  `)
};

////////////////////////////////////////////////////////////

// `beforeId` is undefined or a number
exports.findRecentTopicsForUserId = async function (userId, beforeId) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId))

  return pool.many(sql`
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
    WHERE t.user_id = ${userId} AND t.id < ${beforeId || 1e9}
    GROUP BY t.id, f.id, p.id
    ORDER BY t.id DESC
    LIMIT ${config.RECENT_POSTS_PER_PAGE}
  `)
}

////////////////////////////////////////////////////////////

exports.findUser = async function (userId) {
  debug('[findUser] userId: ' + userId)

  return pool.one(sql`
    SELECT *
    FROM users
    WHERE id = ${userId}
  `)
}

////////////////////////////////////////////////////////////

// Returns an array of Users
// (Case insensitive uname lookup)
exports.findUsersByUnames = async function (unames) {
  assert(_.isArray(unames))
  assert(_.every(unames, _.isString))

  unames = unames.map(s => s.toLowerCase())

  return pool.many(sql`
    SELECT u.*
    FROM users u
    WHERE lower(u.uname) = ANY (${unames}::text[])
  `)
}

////////////////////////////////////////////////////////////

// If toUsrIds is not given, then it's a self-convo
// TODO: Wrap in transaction, Document the args of this fn
exports.createConvo = function (args) {
  debug('[createConvo] args: ', args)
  assert(_.isNumber(args.userId));
  assert(_.isUndefined(args.toUserIds) || _.isArray(args.toUserIds));
  assert(_.isString(args.title));
  assert(_.isString(args.markup));
  assert(_.isString(args.html));

  return pool.withTransaction(async (client) => {
    // Create convo
    const convo = await client.one(sql`
      INSERT INTO convos (user_id, title)
      VALUES (${args.userId}, ${args.title})
      RETURNING *
    `)

    // Insert participants and the PM in parallel

    const tasks = args.toUserIds.map((toUserId) => {
      // insert each receiving participant
      client.query(sql`
        INSERT INTO convos_participants (convo_id, user_id)
        VALUES (${convo.id}, ${toUserId})
      `)
    }).concat([
      // insert the sending participant
      client.query(sql`
        INSERT INTO convos_participants (convo_id, user_id)
        VALUES (${convo.id}, ${args.userId})
      `),
      // insert the PM
      client.query(sql`
        INSERT INTO pms
          (convo_id, user_id, ip_address, markup, html, idx)
        VALUES (
          ${convo.id}, ${args.userId}, ${args.ipAddress},
          ${args.markup}, ${args.html},
          0
        )
        RETURNING *
      `)
    ])

    const results = await Promise.all(tasks)

    // Assoc firstPm to the returned convo
    convo.firstPm = _.last(results).rows[0]
    convo.pms_count++  // This is a stale copy so we need to manually inc
    return convo
  })
}

////////////////////////////////////////////////////////////

// Only returns user if reset token has not expired
// so this can be used to verify tokens
exports.findUserByResetToken = function (resetToken) {
  // Short circuit if it's not even a UUID
  if (!belt.isValidUuid(resetToken)) {
    return
  }

  return pool.one(sql`
    SELECT *
    FROM users u
    WHERE u.id = (
      SELECT rt.user_id
      FROM active_reset_tokens rt
      WHERE rt.token = ${resetToken}
    )
  `)
}

////////////////////////////////////////////////////////////

exports.findUserBySessionId = async function (sessionId) {
  assert(belt.isValidUuid(sessionId))

  const user = await pool.one(sql`
    UPDATE users
    SET last_online_at = NOW()
    WHERE id = (
      SELECT u.id
      FROM users u
      WHERE u.id = (
        SELECT s.user_id
        FROM active_sessions s
        WHERE s.id = ${sessionId}
      )
    )
    RETURNING *
  `)

  if (user && user.roles) {
    user.roles = pgArray.parse(user.roles, _.identity)
  }

  return user
}

////////////////////////////////////////////////////////////

exports.createSession = wrapOptionalClient(createSession)
async function  createSession(client, props) {
  debug('[createSession] props: ', props)
  assert(belt.isDBClient(client))
  assert(_.isNumber(props.userId))
  assert(_.isString(props.ipAddress))
  assert(_.isString(props.interval))

  const uuid = genUuid.v4()

  return client.one(sql`
    INSERT INTO sessions (user_id, id, ip_address, expired_at)
    VALUES (${props.userId}, ${uuid}, ${props.ipAddress}::inet,
      NOW() + ${props.interval}::interval)
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Sync with db.findTopicsWithHasPostedByForumId
exports.findTopicsByForumId = async function (forumId, limit, offset) {
  debug('[%s] forumId: %s, limit: %s, offset: %s',
        'findTopicsByForumId', forumId, limit, offset)

  return pool.many(sql`
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
WHERE t.forum_id = ${forumId}
  AND t.is_hidden = false
ORDER BY t.is_sticky DESC, t.latest_post_at DESC
LIMIT ${limit}
OFFSET ${offset}
  `)
}

////////////////////////////////////////////////////////////

// Sync with db.findTopicsByForumId
// Same as db.findTopicsByForumId except each forum has a has_posted boolean
// depending on whether or not userId has posted in each topic
exports.findTopicsWithHasPostedByForumId = async function (forumId, limit, offset, userId) {
  assert(userId)
  debug('[findTopicsWithHasPostedByForumId] forumId: %s, userId: %s',
        forumId, userId)

  return pool.many(sql`
SELECT
  EXISTS(
    SELECT 1 FROM posts WHERE topic_id = t.id AND user_id = ${userId}
  ) has_posted,
  (
    SELECT t.latest_post_id > (
      SELECT COALESCE(MAX(w.watermark_post_id), 0)
      FROM topics_users_watermark w
      WHERE w.topic_id = t.id
        AND w.user_id = ${userId}
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
WHERE t.forum_id = ${forumId}
  AND t.is_hidden = false
ORDER BY t.is_sticky DESC, t.latest_post_at DESC
LIMIT ${limit}
OFFSET ${offset}
  `)
}

////////////////////////////////////////////////////////////

exports.updateUserPassword = async function (userId, password) {
  assert(_.isNumber(userId))
  assert(_.isString(password))

  const digest = await belt.hashPassword(password)

  return pool.one(sql`
    UPDATE users
    SET digest = ${digest}
    WHERE id = ${userId}
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Keep updatePost and updatePm in sync
exports.updatePost = async function (postId, markup, html) {
  assert(_.isString(markup))
  assert(_.isString(html))

  return pool.one(sql`
UPDATE posts
SET markup = ${markup}, html = ${html}, updated_at = NOW()
WHERE id = ${postId}
RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Keep updatePost and updatePm in sync
exports.updatePm = async function (id, markup, html) {
  assert(_.isString(markup))
  assert(_.isString(html))

  return pool.one(sql`
UPDATE pms
SET markup = ${markup}, html = ${html}, updated_at = NOW()
WHERE id = ${id}
RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Attaches topic and forum to post for authorization checks
// See cancan.js 'READ_POST'
exports.findPostWithTopicAndForum = async function (postId) {
  return pool.one(sql`
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum"
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.id = ${postId}
  `)
}

////////////////////////////////////////////////////////////

// Keep findPost and findPm in sync
exports.findPostById = exports.findPost = async function (postId) {
  return pool.one(sql`
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum",
  (SELECT json_agg(tb.banned_id) FROM topic_bans tb WHERE tb.topic_id = t.id) banned_ids
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.id = ${postId}
  `)
}

////////////////////////////////////////////////////////////

exports.findPmById = exports.findPm = async function findPm (id) {
  return pool.one(sql`
SELECT
  pms.*,
  to_json(c.*) "convo"
FROM pms
JOIN convos c ON pms.convo_id = c.id
WHERE pms.id = ${id}
  `)
}

////////////////////////////////////////////////////////////

exports.findUsersContainingString = async function (searchTerm) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm))

  return pool.many(sql`
SELECT *
FROM users
WHERE lower(uname) LIKE '%' || lower(${searchTerm}::text) || '%'
ORDER BY id DESC
LIMIT ${config.USERS_PER_PAGE}::bigint
  `)
}

////////////////////////////////////////////////////////////

// Ignore nuked users
exports.paginateUsers = async function (beforeId = 1e9) {
  return pool.many(sql`
    SELECT *
    FROM users
    WHERE id < ${beforeId}
      AND is_nuked = false
    ORDER BY id DESC
    LIMIT ${config.USERS_PER_PAGE}::bigint
  `)
}

////////////////////////////////////////////////////////////

exports.findUsersContainingStringWithId = async function (searchTerm, beforeId) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm))

  return pool.many(sql`
SELECT *
FROM users
WHERE
lower(uname) LIKE '%' || lower(${searchTerm}::text) || '%'
AND id < ${beforeId}
ORDER BY id DESC
LIMIT ${config.USERS_PER_PAGE}::bigint
  `)
}

////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////

exports.findPmsByConvoId = async function (convoId, page) {
  const fromIdx = (page - 1) * config.POSTS_PER_PAGE;
  const toIdx = fromIdx + config.POSTS_PER_PAGE;

  return pool.many(sql`
SELECT
  pms.*,
  to_json(u.*) "user"
FROM pms
JOIN users u ON pms.user_id = u.id
WHERE pms.convo_id = ${convoId} AND pms.idx >= ${fromIdx} AND pms.idx < ${toIdx}
GROUP BY pms.id, u.id
ORDER BY pms.id
  `)
}

////////////////////////////////////////////////////////////

exports.findPostsByTopicId = async function (topicId, postType, page) {
  debug('[findPostsByTopicId] topicId: %s, postType: %s, page',
        topicId, postType, page)
  assert(_.isNumber(page))

  const fromIdx = (page - 1) * config.POSTS_PER_PAGE
  const toIdx = fromIdx + config.POSTS_PER_PAGE
  debug('%s <= post.idx < %s', fromIdx, toIdx)

  const rows = await pool.many(sql`
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
    WHERE p.topic_id = ${topicId}
      AND p.type = ${postType}
      AND p.idx >= ${fromIdx}
      AND p.idx < ${toIdx}
    GROUP BY p.id, u.id, t.id, f.id, s.id
    ORDER BY p.id
  `)

  return rows.map((row) => {
    // Make current_status a property of post.user where it makes more sense
    if (row.current_status) {
      row.current_status.created_at = new Date(row.current_status.created_at)
    }
    row.user.current_status = row.current_status
    delete row.current_status
    return row
  })
}

////////////////////////////////////////////////////////////

// TODO: Order by
// TODO: Pagination
exports.findForumWithTopics = async function (forumId) {
  const forum = await pool.one(sql`
    SELECT
      f.*,
      to_json(array_agg(t.*)) "topics",
      to_json(p.*) "latest_post"
    FROM forums f
    LEFT OUTER JOIN topics t ON f.id = t.forum_id
    WHERE f.id = ${forumId}
    GROUP BY f.id
  `)

  if (!forum) return null

  // The query will set forum.topics to `[null]` if it has
  // none, so compact it to just `[]`.
  forum.topics = _.compact(forum.topics)

  return forum
}

////////////////////////////////////////////////////////////

// Keep findPostWithTopic and findPmWithConvo in sync
exports.findPostWithTopic = async function (postId) {
  return pool.one(sql`
    SELECT
      p.*,
      to_json(t.*) "topic"
    FROM posts p
    JOIN topics t ON p.topic_id = t.id
    WHERE p.id = ${postId}
    GROUP BY p.id, t.id
  `)
}

////////////////////////////////////////////////////////////

// Keep findPostWithTopic and findPmWithConvo in sync
exports.findPmWithConvo = async function (pmId) {
  return pool.one(sql`
SELECT
  pms.*,
  to_json(c.*) "convo",
  to_json(array_agg(u.*)) "participants"
FROM pms
JOIN convos c ON pms.convo_id = c.id
JOIN convos_participants cp ON cp.convo_id = pms.convo_id
JOIN users u ON cp.user_id = u.id
WHERE pms.id = ${pmId}
GROUP BY pms.id, c.id
  `)
}

////////////////////////////////////////////////////////////

// Returns created PM
exports.createPm = async function (props) {
  assert(_.isNumber(props.userId))
  assert(props.convoId)
  assert(_.isString(props.markup))
  assert(_.isString(props.html))

  return pool.one(sql`
    INSERT INTO pms (user_id, ip_address, convo_id, markup, html)
    VALUES (${props.userId}, ${props.ipAddress}::inet, ${props.convoId},
      ${props.markup}, ${props.html})
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Args:
// - userId      Required Number/String
// - ipAddress   Optional String
// - markup      Required String
// - topicId     Required Number/String
// - type        Required String, ic | ooc | char
// - isRoleplay  Required Boolean
exports.createPost = async function (args) {
  debug(`[createPost] args:`, args)
  assert(_.isNumber(args.userId))
  assert(_.isString(args.ipAddress))
  assert(_.isString(args.markup))
  assert(_.isString(args.html))
  assert(args.topicId)
  assert(_.isBoolean(args.isRoleplay))
  assert(['ic', 'ooc', 'char'].includes(args.type))

  return pool.one(sql`
    INSERT INTO posts
      (user_id, ip_address, topic_id, markup, html, type, is_roleplay)
    VALUES (${args.userId}, ${args.ipAddress}::inet,
      ${args.topicId}, ${args.markup},
      ${args.html}, ${args.type}, ${args.isRoleplay})
    RETURNING *
  `)
}

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
exports.createTopic = async function (props) {
  debug('[createTopic]', props)
  assert(_.isNumber(props.userId))
  assert(props.forumId)
  assert(_.isString(props.ipAddress))
  assert(_.isString(props.title))
  assert(_.isString(props.markup))
  assert(_.isString(props.html))
  assert(_.isBoolean(props.isRoleplay))
  assert(['ic', 'ooc', 'char'].includes(props.postType))
  assert(_.isArray(props.tagIds) || _.isUndefined(props.tagIds))
  // Only roleplays have join-status
  if (props.isRoleplay)
    assert(_.isString(props.joinStatus))
  else
    assert(_.isUndefined(props.joinStatus))

  props.is_ranked = !!props.is_ranked

  return pool.withTransaction(async (client) => {
    // Create topic
    const topic = await client.one(sql`
      INSERT INTO topics
        (forum_id, user_id, title, is_roleplay, join_status, is_ranked)
      VALUES (${props.forumId}, ${props.userId}, ${props.title},
        ${props.isRoleplay}, ${props.joinStatus}, ${props.is_ranked})
      RETURNING *
    `)

    // Create topic's first post
    const post = await client.one(sql`
      INSERT INTO posts
        (topic_id, user_id, ip_address, markup, html, type, is_roleplay, idx)
      VALUES (${topic.id}, ${props.userId}, ${props.ipAddress}::inet,
       ${props.markup}, ${props.html}, ${props.postType}, ${props.isRoleplay}, 0)
      RETURNING *
    `)

    // Attach post to topic so that it can be passed into antispam process()
    topic.post = post

    // Create tags if given
    if (props.tagIds) {
      const tasks = props.tagIds.map((tagId) => client.query(sql`
        INSERT INTO tags_topics (topic_id, tag_id)
        VALUES (${topic.id}, ${tagId})
      `))
      await Promise.all(tasks)
    }

    return topic
  })
}

////////////////////////////////////////////////////////////

// Generic user-update route. Intended to be paired with
// the generic PUT /users/:userId route.
// TODO: Use the knex updater instead
exports.updateUser = async (userId, attrs) => {
  debug('[updateUser] attrs', attrs);

  return pool.one(sql`
    UPDATE users
    SET
      email = COALESCE(${attrs.email}, email),
      sig = COALESCE(${attrs.sig}, sig),
      avatar_url = COALESCE(${attrs.avatar_url}, avatar_url),
      hide_sigs = COALESCE(${attrs.hide_sigs}, hide_sigs),
      is_ghost = COALESCE(${attrs.is_ghost}, is_ghost),
      sig_html = COALESCE(${attrs.sig_html}, sig_html),
      custom_title = COALESCE(${attrs.custom_title}, custom_title),
      is_grayscale = COALESCE(${attrs.is_grayscale}, is_grayscale),
      force_device_width = COALESCE(${attrs.force_device_width}, force_device_width),
      hide_avatars = COALESCE(${attrs.hide_avatars}, hide_avatars),
      show_arena_stats = COALESCE(${attrs.show_arena_stats}, show_arena_stats)
    WHERE id = ${userId}
    RETURNING *
  `).catch((err) => {
    if (err.code === '23505') {
      if (/"unique_email"/.test(err.toString())) {
        throw 'EMAIL_TAKEN'
      }
    }
    throw err
  })
}

////////////////////////////////////////////////////////////

exports.updateUserRole = async function (userId, role) {
  return pool.one(sql`
    UPDATE users
    SET role = ${role}
    WHERE id = ${userId}
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// @fast
exports.findForumById = exports.findForum = async function (forumId) {
  return pool.one(sql`
    SELECT
      f.*,
      to_json(f2.*) "child_forum",
      to_json(f3.*) "parent_forum"
    FROM forums f
    LEFT OUTER JOIN forums f2 ON f.id = f2.parent_forum_id
    LEFT OUTER JOIN forums f3 ON f.parent_forum_id = f3.id
    WHERE f.id = ${forumId}
    GROUP BY f.id, f2.id, f3.id
  `)
}

////////////////////////////////////////////////////////////

// TODO: This should be moved to some admin namespace since
// it includes the nuke info
exports.findLatestUsers = async function (limit = 25) {
  debug(`[findLatestUsers]`)
  return pool.many(sql`
    SELECT
      u.*,
      (
        SELECT to_json(users.*)
        FROM users
        WHERE u.approved_by_id = users.id
      ) approved_by,
      (
        SELECT to_json(users.*)
        FROM users
        JOIN nuked_users ON nuked_users.nuker_id = users.id
        WHERE nuked_users.user_id = u.id
      ) nuked_by
    FROM users u
    ORDER BY id DESC
    LIMIT ${limit}
  `)
}

////////////////////////////////////////////////////////////

// Also has cat.forums array
exports.findModCategory = async function () {
  debug(`[findModCategory]`)
  const MOD_CATEGORY_ID = 4
  return pool.one(sql`
    SELECT c.*
    FROM categories c
    WHERE c.id = ${MOD_CATEGORY_ID}
  `)
}

////////////////////////////////////////////////////////////

// Only returns non-mod-forum categories
exports.findCategories = async function () {
  return pool.many(sql`
    SELECT c.*
    FROM categories c
    ORDER BY c.pos
  `)
};

////////////////////////////////////////////////////////////

exports.findCategoriesWithForums = async function () {
  const categories = await pool.many(sql`
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
                'slug', u.slug,
                'avatar_url', u.avatar_url
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
  `)

  categories.forEach((c) => {
    c.forums = _.sortBy(c.forums, 'pos')
  })

  return categories
}

////////////////////////////////////////////////////////////

// Creates a user and a session (logs them in).
// - Returns {:user <User>, :session <Session>}
// - Use `createUser` if you only want to create a user.
//
// Throws: 'UNAME_TAKEN', 'EMAIL_TAKEN'
exports.createUserWithSession = async function (props) {
  debug('[createUserWithSession] props: ', props)
  assert(_.isString(props.uname))
  assert(_.isString(props.ipAddress))
  assert(_.isString(props.password))
  assert(_.isString(props.email))

  const digest = await belt.hashPassword(props.password)
  const slug = belt.slugifyUname(props.uname)

  return pool.withTransaction(async (client) => {
    let user

    try {
      user = await client.one(sql`
        INSERT INTO users (uname, digest, email, slug, hide_sigs)
        VALUES (${props.uname}, ${digest}, ${props.email}, ${slug}, true)
        RETURNING *
      `)
    } catch (err) {
      if (err.code === '23505') {
        if (/unique_username/.test(ex.toString()))
          throw 'UNAME_TAKEN'
        else if (/unique_email/.test(ex.toString()))
          throw 'EMAIL_TAKEN'
      }
      throw err
    }

    const session = await createSession(client, {
      userId: user.id,
      ipAddress: props.ipAddress,
      interval: '1 year'  // TODO: Decide how long to log user in upon registration
    })

    return { user, session }
  })
}

////////////////////////////////////////////////////////////

exports.logoutSession = async function (userId, sessionId) {
  assert(_.isNumber(userId))
  assert(_.isString(sessionId) && belt.isValidUuid(sessionId))

  return pool.query(sql`
    DELETE FROM sessions
    WHERE user_id = ${userId}
      AND id = ${sessionId}
  `)
};

////////////////////////////////////////////////////////////

exports.findForums = async function (categoryIds) {
  debug(`[findForums] categoryIds=%j`, categoryIds)
  assert(_.isArray(categoryIds))

  return pool.many(sql`
    SELECT
      f.*,
      to_json(p.*) "latest_post",
      to_json(t.*) "latest_topic",
      to_json(u.*) "latest_user"
    FROM forums f
    LEFT OUTER JOIN posts p ON f.latest_post_id = p.id
    LEFT OUTER JOIN topics t ON t.id = p.topic_id
    LEFT OUTER JOIN users u ON u.id = p.user_id
    WHERE f.category_id = ANY (${categoryIds}::int[])
    ORDER BY pos;
  `)
    //--WHERE f.category_id IN (${categoryIds}::int[])
}

////////////////////////////////////////////////////////////

// Stats

// https://wiki.postgresql.org/wiki/Count_estimate
exports.getApproxCount = async function (tableName) {
  assert(_.isString(tableName))
  return pool.one(sql`
    SELECT reltuples "count"
    FROM pg_class
    WHERE relname = ${tableName}
  `).then((row) => {
    return row.count
  })
}

////////////////////////////////////////////////////////////

// Ignore nuked users
exports.getLatestUser = async function () {
  return pool.one(sql`
    SELECT *
    FROM users
    WHERE is_nuked = false
    ORDER BY created_at DESC
    LIMIT 1
  `)
}

////////////////////////////////////////////////////////////

// Users online within the last X minutes
exports.getOnlineUsers = async function () {
  return pool.many(sql`
    SELECT *
    FROM users
    WHERE last_online_at > NOW() - interval '15 minutes'
    ORDER BY uname
  `)
}

exports.getMaxTopicId = async function () {
  return pool.one(sql`SELECT MAX(id) "max_id" FROM topics`)
    .then((row) => row.max_id)
}

exports.getMaxPostId = async function () {
  return pool.one(sql`SELECT MAX(id) "max_id" FROM posts`)
    .then((row) => row.max_id)
}

exports.getMaxUserId = async function () {
  return pool.one(sql`SELECT MAX(id) "max_id" FROM users`)
    .then((row) => row.max_id)
}

// https://web.archive.org/web/20131218103719/http://roleplayerguild.com/
const legacyCounts = {
  topics: 210879,
  posts: 9243457,
  users: 44799
}

exports.getStats = async function () {
  let [topicsCount, usersCount, postsCount, latestUser, onlineUsers] =
    await Promise.all([
      exports.getMaxTopicId(), //getApproxCount('topics'),
      exports.getMaxUserId(), //getApproxCount('users'),
      exports.getMaxPostId(), //getApproxCount('posts'),
      exports.getLatestUser(),
      exports.getOnlineUsers()
    ])

  topicsCount += legacyCounts.topics;
  usersCount += legacyCounts.users;
  postsCount += legacyCounts.posts;

  return {topicsCount, usersCount, postsCount, latestUser, onlineUsers}
}

exports.deleteLegacySig = async function (userId) {
  return pool.query(sql`
    UPDATE users SET legacy_sig = NULL WHERE id = ${userId}
  `)
}

exports.findStaffUsers = async function () {
  return pool.many(sql`
    SELECT u.*
    FROM users u
    WHERE u.role IN ('mod', 'smod', 'admin', 'conmod', 'arenamod')
  `)
}

// sub notes have a meta that looks like {ic: true, ooc: true, char: true}
// which indicates which postType the notification has accumulated new
// posts for.
exports.createSubNotification = async function (fromUserId, toUserId, topicId, postType) {
  debug(`[createSubNotification]`, fromUserId, toUserId, topicId)

  assert(['ic', 'ooc', 'char'].includes(postType))
  assert(Number.isInteger(topicId))
  assert(Number.isInteger(fromUserId))
  assert(Number.isInteger(toUserId))

  const meta = { [postType]: true }

  return pool.query(sql`
    INSERT INTO notifications
    (type, from_user_id, to_user_id, topic_id, meta, count)
    VALUES ('TOPIC_SUB', ${fromUserId}, ${toUserId}, ${topicId}, ${meta}, 1)
    ON CONFLICT (type, to_user_id, topic_id) WHERE type = 'TOPIC_SUB'
      DO UPDATE
      SET count = COALESCE(notifications.count, 0) + 1,
          meta = notifications.meta || ${meta}::jsonb
  `)
}

// Users receive this when someone starts a convo with them
exports.createConvoNotification = wrapOptionalClient(createConvoNotification);
async function createConvoNotification (client, opts) {
  assert(_.isNumber(opts.from_user_id))
  assert(_.isNumber(opts.to_user_id))
  assert(opts.convo_id)

  return pool.many(sql`
    INSERT INTO notifications (type, from_user_id, to_user_id, convo_id, count)
    VALUES ('CONVO', ${opts.from_user_id}, ${opts.to_user_id}, ${opts.convo_id}, 1)
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Tries to create a convo notification.
// If to_user_id already has a convo notification for this convo, then
// increment the count
exports.createPmNotification = async function (opts) {
  debug('[createPmNotification] opts: ', opts)
  assert(_.isNumber(opts.from_user_id))
  assert(_.isNumber(opts.to_user_id))
  assert(opts.convo_id)

  return pool.query(sql`
    INSERT INTO notifications (type, from_user_id, to_user_id, convo_id, count)
    VALUES ('CONVO', ${opts.from_user_id}, ${opts.to_user_id}, ${opts.convo_id}, 1)
    ON CONFLICT (to_user_id, convo_id) DO UPDATE
      SET count = COALESCE(notifications.count, 0) + 1
  `)
}

// type is 'REPLY_VM' or 'TOPLEVEL_VM'
exports.createVmNotification = async function (data) {
  assert(['REPLY_VM', 'TOPLEVEL_VM'].includes(data.type))
  assert(Number.isInteger(data.from_user_id))
  assert(Number.isInteger(data.to_user_id))
  assert(Number.isInteger(data.vm_id))
  return pool.query(sql`
    INSERT INTO notifications (type, from_user_id, to_user_id, vm_id, count)
    VALUES (
      ${data.type}, ${data.from_user_id}, ${data.to_user_id}, ${data.vm_id}, 1
    )
    ON CONFLICT (vm_id, to_user_id) DO UPDATE
      SET count = COALESCE(notifications.count, 0) + 1
  `)
}

// Pass in optional notification type to filter
exports.findNotificationsForUserId = async function (toUserId, type) {
  assert(Number.isInteger(toUserId))

  return pool.many(sql`
    SELECT *
    FROM notifications
    WHERE to_user_id = ${toUserId}
  `.append(type ? sql`AND type = ${type}` : sql``))
}

// Returns how many rows deleted
exports.deleteConvoNotification = async function (toUserId, convoId) {
  return pool.query(sql`
    DELETE FROM notifications
    WHERE type = 'CONVO'
      AND to_user_id = ${toUserId}
      AND convo_id = ${convoId}
  `).then((result) => result.rowCount)
}

// Returns how many rows deleted
exports.deleteSubNotifications = async function (toUserId, topicIds) {
  assert(Number.isInteger(toUserId))
  assert(Array.isArray(topicIds))
  return pool.query(sql`
    DELETE FROM notifications
    WHERE type = 'TOPIC_SUB'
      AND to_user_id = ${toUserId}
      AND topic_id = ANY (${topicIds})
  `).then((result) => result.rowCount)
}

// Deletes all rows in notifications table for user,
// and also resets the counter caches
exports.clearNotifications = async function (toUserId, notificationIds) {
  assert(Number.isInteger(toUserId))
  assert(Array.isArray(notificationIds))

  await pool.query(sql`
    DELETE FROM notifications
    WHERE
      to_user_id = ${toUserId}
      AND id = ANY (${notificationIds}::int[])
  `)

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  return pool.query(sql`
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
      WHERE n.to_user_id = ${toUserId}
      GROUP BY n.to_user_id
    ) sub
    WHERE users.id = ${toUserId}
      AND sub.to_user_id = ${toUserId}
  `)
}

exports.clearConvoNotifications = async function (toUserId) {
  await pool.query(sql`
    DELETE FROM notifications
    WHERE to_user_id = ${toUserId} AND type = 'CONVO'
  `)

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  return pool.query(sql`
    UPDATE users
    SET convo_notifications_count = 0
    WHERE id = ${toUserId}
  `)
}

// Returns [String]
exports.findAllUnames = async function () {
  return pool.many(sql`
    SELECT uname FROM users ORDER BY uname
  `).then((rows) => rows.map((row) => row.uname))
}

////////////////////////////////////////////////////////////

exports.findRGNTopicForHomepage = async function (topic_id) {
  assert(topic_id)

  return pool.one(sql`
SELECT
  t.id,
  t.title,
  t.created_at,
  to_json(u.*) latest_user,
  to_json(p.*) latest_post
FROM topics t
JOIN posts p ON t.latest_post_id = p.id
JOIN users u ON p.user_id = u.id
WHERE t.id = ${topic_id}
  `)
}

////////////////////////////////////////////////////////////

// Keep in sync with findTopicWithHasSubscribed
exports.findTopicById = async function (topicId) {
  debug(`[findTopicById] topicId=${topicId}`)
  assert(topicId)

  return pool.one(sql`
SELECT
  t.*,
  to_json(f.*) "forum",
  (SELECT to_json(u2.*) FROM users u2 WHERE u2.id = t.user_id) "user",
  (SELECT json_agg(u3.uname) FROM users u3 WHERE u3.id = ANY (t.co_gm_ids::int[])) co_gm_unames,
  (SELECT json_agg(tb.banned_id) FROM topic_bans tb WHERE tb.topic_id = t.id) banned_ids,
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
WHERE t.id = ${topicId}
GROUP BY t.id, f.id
  `)
}

exports.findArenaOutcomesForTopicId = async function (topicId) {
  assert(_.isNumber(topicId))

  return pool.many(sql`
    SELECT
      arena_outcomes.*,
      to_json(users.*) "user"
    FROM arena_outcomes
    JOIN users ON arena_outcomes.user_id = users.id
    WHERE topic_id = ${topicId}
  `)
}

// props:
// - title Maybe String
// - join-status Maybe (jump-in | apply | full)
//
exports.updateTopic = async function (topicId, props) {
  assert(topicId)
  assert(props)

  return pool.one(sql`
    UPDATE topics
    SET
      title = COALESCE(${props.title}, title),
      join_status = COALESCE(${props.join_status}, join_status)::join_status
    WHERE id = ${topicId}
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

exports.createMentionNotification = async function ({
  from_user_id, to_user_id, post_id, topic_id
}) {
  assert(from_user_id)
  assert(to_user_id)
  assert(post_id)
  assert(topic_id)

  return pool.one(sql`
    INSERT INTO notifications
    (type, from_user_id, to_user_id, topic_id, post_id)
    VALUES ('MENTION', ${from_user_id}, ${to_user_id}, ${topic_id}, ${post_id})
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

exports.parseAndCreateMentionNotifications = async function (props) {
  debug('[parseAndCreateMentionNotifications] Started...')
  assert(props.fromUser.id)
  assert(props.fromUser.uname)
  assert(props.markup)
  assert(props.post_id)
  assert(props.topic_id)

  // Array of lowercase unames that don't include fromUser
  let mentionedUnames = belt.extractMentions(props.markup, props.fromUser.uname)
  mentionedUnames = _.take(mentionedUnames, config.MENTIONS_PER_POST)

  // Ensure these are users
  const mentionedUsers = await exports.findUsersByUnames(mentionedUnames)

  // Create the notifications in parallel
  const tasks = mentionedUsers.map((toUser) => {
    return exports.createMentionNotification({
      from_user_id: props.fromUser.id,
      to_user_id:   toUser.id,
      post_id:      props.post_id,
      topic_id:     props.topic_id
    });
  })

  return Promise.all(tasks)
}

////////////////////////////////////////////////////////////

exports.createQuoteNotification = async function ({
  from_user_id, to_user_id, topic_id, post_id
}) {
  assert(from_user_id)
  assert(to_user_id)
  assert(post_id)
  assert(topic_id)

  return pool.one(sql`
    INSERT INTO notifications
    (type, from_user_id, to_user_id, topic_id, post_id)
    VALUES ('QUOTE', ${from_user_id}, ${to_user_id}, ${topic_id}, ${post_id})
    RETURNING *
  `)
}

// Keep in sync with db.parseAndCreateMentionNotifications
exports.parseAndCreateQuoteNotifications = async function (props) {
  debug('[parseAndCreateQuoteNotifications] Started...')
  assert(props.fromUser.id)
  assert(props.fromUser.uname)
  assert(props.markup)
  assert(props.post_id)
  assert(props.topic_id)

  // Array of lowercase unames that don't include fromUser
  let mentionedUnames = belt.extractQuoteMentions(
    props.markup, props.fromUser.uname
  )

  mentionedUnames = _.take(mentionedUnames, config.QUOTES_PER_POST)

  // Ensure these are users
  const mentionedUsers = await exports.findUsersByUnames(mentionedUnames)

  // Create the notifications in parallel
  return Promise.all(mentionedUsers.map((toUser) => {
    return exports.createQuoteNotification({
      from_user_id: props.fromUser.id,
      to_user_id:   toUser.id,
      post_id:      props.post_id,
      topic_id:     props.topic_id
    })
  }))
}

exports.findReceivedNotificationsForUserId = async function (toUserId) {
  return pool.many(sql`
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
WHERE n.to_user_id = ${toUserId}
ORDER BY n.id DESC
LIMIT 50
  `)
}

// Returns how many rows deleted
exports.deleteNotificationsForPostId = async function (toUserId, postId) {
  debug(`[deleteNotificationsForPostId] toUserId=${toUserId}, postId=${postId}`)
  assert(toUserId)
  assert(postId)

  return pool.query(sql`
    DELETE FROM notifications
    WHERE to_user_id = ${toUserId}
      AND post_id = ${postId}
  `).then((result) => result.rowCount)
}

// Viewer tracker /////////////////////////////////////////////////

// - ctx is the Koa context
// - forumId is required
// - topicId is optional
// If user.is_hidden, then we count them as a guest
//
// yield this after the response is sent in routes so user
// doesn't have to wait
//
// TODO: pass in currUser instead of ctx
exports.upsertViewer = async function (ctx, forumId, topicId) {
  assert(ctx)
  assert(forumId)
  if (ctx.currUser && !ctx.currUser.is_ghost) {
    return pool.query(sql`
      INSERT INTO viewers (uname, forum_id, topic_id, viewed_at)
      VALUES (${ctx.currUser.uname}, ${forumId}, ${topicId}, NOW())
      ON CONFLICT (uname) DO UPDATE
        SET forum_id = ${forumId}
          , topic_id = ${topicId}
          , viewed_at = NOW()
    `)
  } else {
    return pool.query(sql`
      INSERT INTO viewers (ip, forum_id, topic_id, viewed_at)
      VALUES (${ctx.ip}, ${forumId}, ${topicId}, NOW())
      ON CONFLICT (ip) DO UPDATE
        SET forum_id = ${forumId}
          , topic_id = ${topicId}
          , viewed_at = NOW()
    `)
  }
}

// Returns map of ForumId->Int
exports.getForumViewerCounts = async function () {
  // Query returns { forum_id: Int, viewers_count: Int } for every forum
  const rows = await pool.many(sql`
SELECT
  f.id "forum_id",
  COUNT(v.*) "viewers_count"
FROM forums f
LEFT OUTER JOIN active_viewers v ON f.id = v.forum_id
GROUP BY f.id
  `)


  const output = {}

  rows.forEach((row) => {
    output[row.forum_id] = row.viewers_count
  })

  return output
}

// Deletes viewers where viewed_at is older than 15 min ago
// Run this in a cronjob
// Returns Int of viewers deleted
exports.clearExpiredViewers = async function () {
  debug('[clearExpiredViewers] Running')

  const rowCount = await pool.query(sql`
    DELETE FROM viewers
    WHERE viewed_at < NOW() - interval '15 minutes'
  `).then((result) => result.rowCount)

  debug('[clearExpiredViewers] Deleted views: ' + rowCount)

  return count
}

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
//
// @fast
exports.findViewersForTopicId = async function (topicId) {
  assert(topicId)

  const viewers = await pool.many(sql`
    SELECT *
    FROM active_viewers
    WHERE topic_id = ${topicId}
    ORDER BY uname
  `)

  return {
    users: _.filter(viewers, 'uname'),
    guests: _.filter(viewers, 'ip')
  }
}

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
//
// @fast
exports.findViewersForForumId = async function (forumId) {
  assert(forumId)

  const viewers = await pool.many(sql`
    SELECT *
    FROM active_viewers
    WHERE forum_id = ${forumId}
    ORDER BY uname
  `)

  return {
    users: viewers.filter((x) => x.uname),
    guests: viewers.filter((x) => x.ip)
  }
}

// leaveRedirect: Bool
exports.moveTopic = async function (topicId, fromForumId, toForumId, leaveRedirect) {
  assert(_.isNumber(toForumId))

  let topic

  if (leaveRedirect) {
    topic = await pool.one(sql`
      UPDATE topics
      SET forum_id = ${toForumId},
          moved_from_forum_id = ${fromForumId},
          moved_at = NOW()
      WHERE id = ${topicId}
      RETURNING *
    `)
  } else {
    topic = await pool.one(sql`
      UPDATE topics
      SET forum_id = ${toForumId}, moved_at = NOW()
      WHERE id = ${topicId}
      RETURNING *
    `)
  }

  // TODO: Put this in transaction

  const [fromForum, toForum] = await Promise.all([
    pool.one(sql`SELECT * FROM forums WHERE id = ${fromForumId}`),
    pool.one(sql`SELECT * FROM forums WHERE id = ${toForumId}`)
  ])

  // If moved topic's latest post is newer than destination forum's latest post,
  // then update destination forum's latest post.
  if (topic.latest_post_id > toForum.latest_post_id) {
    debug('[moveTopic] Updating toForum latest_post_id')
    debug('topic.id: %s, topic.latest_post_id: %s', topic.id, topic.latest_post_id)

    await pool.query(sql`
      UPDATE forums
      SET latest_post_id = ${topic.latest_post_id}
      WHERE id = ${topic.forum_id}
    `)
  }

  // Update fromForum.latest_post_id if it was topic.latest_post_id since
  // we moved the topic out of this forum.
  if (topic.latest_post_id === fromForum.latest_post_id) {
    debug('[moveTopic] Updating fromForum.latest_post_id');
    await pool.query(sql`
      UPDATE forums
      SET latest_post_id = (
        SELECT MAX(t.latest_post_id) "latest_post_id"
        FROM topics t
        WHERE t.forum_id = ${fromForumId}
      )
      WHERE id = ${fromForumId}
    `)
  }

  return topic
}

////////////////////////////////////////////////////////////

// Required props:
// - post_id: Int
// - from_user_id: Int
// - from_user_uname: String
// - to_user_id: Int
// - type: like | laugh | thank
//
// If returns falsey, then rating already exists.
exports.ratePost = async function (props) {
  assert(props.post_id);
  assert(props.from_user_id);
  assert(props.from_user_uname);
  assert(props.to_user_id);
  assert(props.type);

  return pool.one(sql`
    INSERT INTO ratings (from_user_id, from_user_uname, post_id, type, to_user_id)
    VALUES (
      ${props.from_user_id},
      ${props.from_user_uname},
      ${props.post_id},
      ${props.type},
      ${props.to_user_id}
    )
    ON CONFLICT (from_user_id, post_id) DO NOTHING
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

exports.findLatestRatingForUserId = async function (userId) {
  assert(userId)

  return pool.one(sql`
    SELECT *
    FROM ratings
    WHERE from_user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 1
  `)
}

////////////////////////////////////////////////////////////

exports.findRatingByFromUserIdAndPostId = async function (from_user_id, post_id) {
  assert(from_user_id)
  assert(post_id)

  return pool.one(sql`
    SELECT *
    FROM ratings
    WHERE from_user_id = ${from_user_id}
      AND post_id = ${post_id}
  `)
}

exports.deleteRatingByFromUserIdAndPostId = async function (from_user_id, post_id) {
  assert(from_user_id)
  assert(post_id)

  return pool.query(sql`
    DELETE FROM ratings
    WHERE from_user_id = ${from_user_id} AND post_id = ${post_id}
    RETURNING *
  `)
}

exports.deleteLegacyAvatar = async function (userId) {
  return pool.one(sql`
    UPDATE users
    SET legacy_avatar_url = null
    WHERE id = ${userId}
    RETURNING *
  `)
}

exports.deleteAvatar = async function (userId) {
  return pool.one(sql`
UPDATE users
SET legacy_avatar_url = null, avatar_url = ''
WHERE id = ${userId}
RETURNING *
  `)
}

// User receives this when someone rates their post
// Required props:
// - from_user_id
// - to_user_id
// - post_id
// - topic_id
// - rating_type: Any rating_type enum
// Returns created notification
exports.createRatingNotification = async function (props) {
  assert(props.from_user_id)
  assert(props.to_user_id)
  assert(props.post_id)
  assert(props.topic_id)
  assert(props.rating_type)

  // TODO: does that {type: _} thing work?

  return pool.one(sql`
INSERT INTO notifications
(type, from_user_id, to_user_id, meta, post_id, topic_id)
VALUES ('RATING', ${props.from_user_id}, ${props.to_user_id},
  ${{type: props.rating_type}}, ${props.post_id}, ${props.topic_id})
RETURNING *
  `)
}

// -> JSONString
//
// Only gets users that:
// - logged on in the last year
// - have at least one post
// - are not nuked
exports.findAllUnamesJson = async function () {
  return pool.one(sql`
    SELECT json_agg(uname) unames
    FROM users
    WHERE posts_count > 0
      AND is_nuked = false
      AND last_online_at > NOW() - '1 year'::interval
  `).then((row) => row.unames)
}

exports.updateTopicCoGms = async function (topicId, userIds) {
  assert(topicId)
  assert(_.isArray(userIds))

  return pool.one(sql`
    UPDATE topics
    SET co_gm_ids = ${userIds}
    WHERE id = ${topicId}
    RETURNING *
  `)
}

exports.findAllTags = async function () {
  return pool.many(sql`SELECT * FROM tags`)
}

// Returns [TagGroup] where each group has [Tag] array bound to `tags` property
exports.findAllTagGroups = async function () {
  return pool.many(sql`
    SELECT
      *,
      (SELECT json_agg(t.*) FROM tags t WHERE t.tag_group_id = tg.id) tags
    FROM tag_groups tg
  `)
}

// topicId :: String | Int
// tagIds :: [Int]
exports.updateTopicTags = async function (topicId, tagIds) {
  assert(topicId)
  assert(_.isArray(tagIds))

  return pool.withTransaction(async (client) => {
    await client.query(sql`
      DELETE FROM tags_topics
      WHERE topic_id = ${topicId}
    `)
    // Now create the new bridge links in parallel
    return Promise.all(tagIds.map((tagId) => {
      return client.query(sql`
        INSERT INTO tags_topics (topic_id, tag_id)
        VALUES (${topicId}, ${tagId})
      `)
    }))
  })
}

// Example return:
//
//   uname   count   latest_at
//   foo     33      2015-02-27 06:50:18.943-06
//   Mahz    125     2015-03-01 03:32:49.539-06
//
// `latest_post_at` is the timestamp of the latest post by that
// user that has this ip address.
exports.findUsersWithPostsWithIpAddress = async function (ip_address) {
  assert(ip_address)

  return pool.many(sql`
    SELECT
      u.uname           uname,
      u.slug            slug,
      COUNT(p.id)       count,
      MAX(p.created_at) latest_at
    FROM posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.ip_address = ${ip_address}
    GROUP BY u.uname, u.slug
  `)
}

exports.findUsersWithPmsWithIpAddress = async function (ip_address) {
  assert(ip_address)

  return pool.many(sql`
    SELECT
      u.uname           uname,
      u.slug            slug,
      COUNT(p.id)       count,
      MAX(p.created_at) latest_at
    FROM pms p
    JOIN users u ON p.user_id = u.id
    WHERE p.ip_address = ${ip_address}
    GROUP BY u.uname, u.slug
  `)
}

// Returns [String]
exports.findAllIpAddressesForUserId = async function (user_id) {
  assert(user_id)

  return pool.many(sql`
    SELECT DISTINCT ip_address
    FROM posts
    WHERE user_id = ${user_id} AND ip_address IS NOT NULL

    UNION

    SELECT DISTINCT ip_address
    FROM pms
    WHERE user_id = ${user_id} AND ip_address IS NOT NULL
  `).then((rows) => rows.map((row) => row.ip_address))
}

// Returns latest 5 unhidden checks
exports.findLatestChecks = async function () {
  const forumIds = [12, 38, 13, 14, 15, 16, 40, 43]

  return pool.many(sql`
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
      t.forum_id = ANY (${forumIds}::int[])
      AND NOT t.is_hidden
    ORDER BY t.id DESC
    LIMIT 5
  `)
}

// Returns latest 5 unhidden roleplays
exports.findLatestRoleplays = async function () {
  const forumIds = [3, 4, 5, 6, 7, 39, 42]
  return pool.many(sql`
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
  t.forum_id = ANY (${forumIds}::int[])
  AND NOT t.is_hidden
ORDER BY t.id DESC
LIMIT 5
  `)
}

exports.findAllPublicTopicUrls = async function () {
  return pool.many(sql`
    SELECT id, title
    FROM topics
    WHERE
      is_hidden = false
      AND forum_id IN (
        SELECT id
        FROM forums
        WHERE category_id NOT IN (4)
      )
    ORDER BY id
  `).then((rows) => {
    return rows.map((row) => pre.presentTopic(row).url)
  })
}

exports.findPostsByIds = async function (ids) {
  assert(_.isArray(ids))
  ids = ids.map(Number)   // Ensure ids are numbers, not strings

  const rows = await pool.many(sql`
    SELECT
      p.*,
      to_json(t.*) topic,
      to_json(f.*) forum,
      to_json(u.*) "user"
    FROM posts p
    JOIN topics t ON p.topic_id = t.id
    JOIN forums f ON t.forum_id = f.id
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ANY (${ids}::int[])
  `)

  // Reorder posts by the order of ids passed in
  const out = []

  ids.forEach((id) => {
    const row = rows.find((row) => row.id === id)
    if (row) out.push(row)
  })

  return out
}

////////////////////////////////////////////////////////////

exports.getUnamesMappedToIds = async function () {
  const rows = await pool.many(sql`
    SELECT uname, id FROM users
  `)

  const out = {}

  rows.forEach((row) => {
    out[row.uname.toLowerCase()] = row.id
  })

  return out
}

////////////////////////////////////////////////////////////

// Trophies are returned newly-awarded first
exports.findTrophiesForUserId = async function (user_id) {
  return pool.many(sql`
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
WHERE tu.user_id = ${user_id}
ORDER BY tu.awarded_at DESC
  `)
}

////////////////////////////////////////////////////////////

// Finds one trophy
exports.findTrophyById = async function (trophy_id) {
  return pool.one(sql`
    SELECT
      t.*,
      to_json(tg.*) "group"
    FROM trophies t
    LEFT OUTER JOIN trophy_groups tg ON t.group_id = tg.id
    WHERE t.id = ${trophy_id}
    GROUP BY t.id, tg.id
  `)
}

////////////////////////////////////////////////////////////

exports.findTrophiesByGroupId = async function (group_id) {
  return pool.many(sql`
    SELECT *
    FROM trophies t
    WHERE t.group_id = ${group_id}
    ORDER BY t.id ASC
  `)
}

////////////////////////////////////////////////////////////

exports.findTrophyGroups = async function () {
  return pool.many(sql`
    SELECT *
    FROM trophy_groups
    ORDER BY id DESC
  `)
}

////////////////////////////////////////////////////////////

exports.findTrophyGroupById = async function (group_id) {
  return pool.one(sql`
    SELECT *
    FROM trophy_groups tg
    WHERE tg.id = ${group_id}
  `)
};

////////////////////////////////////////////////////////////

// title Required
// description_markup Optional
// description_html Optional
exports.updateTrophyGroup = async function (id, title, desc_markup, desc_html) {
  return pool.one(sql`
    UPDATE trophy_groups
    SET
      title = ${title},
      description_markup = ${desc_markup},
      description_html = ${desc_html}
    WHERE id = ${id}
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Update individual trophy
//
// title Required
// description_markup Optional
// description_html Optional
exports.updateTrophy = async function (id, title, desc_markup, desc_html) {
  assert(Number.isInteger(id))

  return pool.one(sql`
UPDATE trophies
SET
  title = ${title},
  description_markup = ${desc_markup},
  description_html = ${desc_html}
WHERE id = ${id}
RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Update trophy<->user bridge record
//
// message_markup Optional
// message_html Optional
exports.updateTrophyUserBridge = async function (id, message_markup, message_html) {
  assert(Number.isInteger(id))

  return pool.one(sql`
    UPDATE trophies_users
    SET
      message_markup = ${message_markup},
      message_html = ${message_html}}
    WHERE id = ${id}
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

exports.deactivateCurrentTrophyForUserId = async function (user_id) {
  assert(_.isNumber(user_id))

  return pool.one(sql`
    UPDATE users
    SET active_trophy_id = NULL
    WHERE id = ${user_id}
  `)
}

////////////////////////////////////////////////////////////

exports.updateUserActiveTrophyId = async function (user_id, trophy_id) {
  assert(_.isNumber(user_id))
  assert(_.isNumber(trophy_id))

  return pool.one(sql`
    UPDATE users
    SET active_trophy_id = ${trophy_id}
    WHERE id = ${user_id}
  `)
};

////////////////////////////////////////////////////////////

exports.findTrophyUserBridgeById = async function (id) {
  debug('[findTrophyUserBridgeById] id=%j', id)
  assert(id)

  return pool.one(sql`
    SELECT
      tu.*,
      to_json(t.*) AS trophy,
      to_json(u.*) AS user
    FROM trophies_users tu
    JOIN trophies t ON tu.trophy_id = t.id
    JOIN users u ON tu.user_id = u.id
    WHERE tu.id = ${id}
  `)
}

////////////////////////////////////////////////////////////

// Deprecated now that I've added a primary key serial to trophies_users.
//
// Instead, use db.findTrophyUserBridgeById(id)
exports.findTrophyByIdAndUserId = async function (trophy_id, user_id) {
  assert(_.isNumber(user_id))
  assert(_.isNumber(trophy_id))

  return pool.one(sql`
    SELECT trophies.*
    FROM trophies_users
    JOIN trophies ON trophies_users.trophy_id = trophies.id
    WHERE trophies_users.trophy_id = ${trophy_id}
      AND trophies_users.user_id = ${user_id}
    LIMIT 1
  `)
}

////////////////////////////////////////////////////////////

exports.findWinnersForTrophyId = async function (trophy_id) {
  return pool.many(sql`
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
    WHERE tu.trophy_id = ${trophy_id}
  `)
}

////////////////////////////////////////////////////////////

// description_markup and _html are optional
//
// Returns created trophy group
exports.createTrophyGroup = async function (title, description_markup, description_html) {
  assert(_.isString(title))
  assert(_.isUndefined(description_markup) || _.isString(description_markup))
  assert(_.isUndefined(description_html) || _.isString(description_html))

  return pool.one(sql`
INSERT INTO trophy_groups (title, description_markup, description_html)
VALUES (${title}, ${description_markup}, ${description_html})
RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// props must have user_id (Int), text (String), html (String) properties
exports.createStatus = async function ({user_id, html, text}) {
  assert(Number.isInteger(user_id))
  assert(typeof text === 'string')
  assert(typeof html === 'string')

  return pool.one(sql`
    INSERT INTO statuses (user_id, text, html)
    VALUES (${user_id}, ${text}, ${html})
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// @fast
exports.findLatestStatusesForUserId = async function (user_id) {
  return pool.many(sql`
    SELECT *
    FROM statuses
    WHERE user_id = ${user_id}
    ORDER BY created_at DESC
    LIMIT 5
  `)
}

////////////////////////////////////////////////////////////

exports.findStatusById = async function (id) {
  return pool.one(sql`
    SELECT
      us.*,
      to_json(u.*) "user"
    FROM statuses us
    JOIN users u ON us.user_id = u.id
    WHERE us.id = ${id}
  `)
}

////////////////////////////////////////////////////////////

exports.deleteStatusById = async function (id) {
  return pool.query(sql`
    DELETE FROM statuses
    WHERE id = ${id}
  `)
}

////////////////////////////////////////////////////////////

exports.findLatestStatuses = async function () {
  return pool.many(sql`
    SELECT
      us.*,
      to_json(u.*) "user"
    FROM statuses us
    JOIN users u ON us.user_id = u.id
    ORDER BY created_at DESC
    LIMIT 8
  `)
}

////////////////////////////////////////////////////////////

exports.clearCurrentStatusForUserId = async function (user_id) {
  assert(user_id)

  return pool.query(sql`
UPDATE users
SET current_status_id = NULL
WHERE id = ${user_id}
  `)
}

////////////////////////////////////////////////////////////

exports.findAllStatuses = async function () {
  // This query was hilariously slow. But I hate the rewrite
  // below. Is there a better way?
  //
  // SELECT
  //   s.*,
  //   to_json(u.*) "user",
  //   json_agg(likers.uname) "likers"
  // FROM statuses s
  // JOIN users u ON s.user_id = u.id
  // LEFT OUTER JOIN status_likes ON s.id = status_likes.status_id
  // LEFT OUTER JOIN users likers ON status_likes.user_id = likers.id
  // GROUP BY s.id, u.id
  // ORDER BY s.created_at DESC
  // LIMIT 100
  const statuses = await pool.many(sql`
WITH sids AS (
  SELECT id
  FROM statuses
  ORDER BY created_at DESC
  LIMIT 100
)
SELECT
  s.*,
  (
    SELECT to_json(u.*)
    FROM users u
    WHERE u.id = s.user_id
  ) "user",
  (
    SELECT json_agg(u2.uname)
    FROM users u2
    LEFT OUTER JOIN status_likes
      ON s.id = status_likes.status_id
      AND u2.id = status_likes.user_id
    WHERE status_likes.status_id = s.id
  ) "likers"
FROM statuses s
WHERE s.id IN (SELECT id FROM sids)
ORDER BY s.created_at DESC
  `)

  statuses.forEach((status) => {
    status.likers = (status.likers || []).filter(Boolean)
  })

  return statuses
}

exports.likeStatus = async function ({user_id, status_id}) {
  assert(Number.isInteger(user_id))
  assert(Number.isInteger(status_id))

  return pool.withTransaction(async (client) => {
    // 1. Create status_likes row

    await client.query(sql`
      INSERT INTO status_likes (status_id, user_id)
      VALUES (${status_id}, ${user_id})
    `)

    // 2. Update status

    return client.query(sql`
      UPDATE statuses
      SET liked_user_ids = array_append(liked_user_ids, ${user_id})
      WHERE id = ${status_id}
    `)
  }).catch((err) => {
    if (err.code === '23505') {
      return
    }
    throw err
  })
}

////////////////////////////////////////////////////////////

// Returns created_at Date OR null for user_id
exports.latestStatusLikeAt = async function (user_id) {
  assert(user_id)

  const row = await pool.one(sql`
    SELECT MAX(created_at) created_at
    FROM status_likes
    WHERE user_id = ${user_id}
  `)

  return row && row.created_at
}

////////////////////////////////////////////////////////////

exports.updateTopicWatermark = async function (props) {
  debug('[updateTopicWatermark] props:', props)
  assert(props.topic_id)
  assert(props.user_id)
  assert(props.post_type)
  assert(props.post_id)

  return pool.query(sql`
    INSERT INTO topics_users_watermark
      (topic_id, user_id, post_type, watermark_post_id)
    VALUES (
      ${props.topic_id}, ${props.user_id}, ${props.post_type}, ${props.post_id}
    )
    ON CONFLICT (topic_id, user_id, post_type) DO UPDATE
      SET watermark_post_id = GREATEST(topics_users_watermark.watermark_post_id, ${props.post_id})
  `)
}

////////////////////////////////////////////////////////////

exports.findFirstUnreadPostId = async function({topic_id, post_type, user_id}) {
  assert(topic_id)
  assert(post_type)

  const row = await pool.one(sql`
    SELECT COALESCE(
      MIN(p.id),
      (
        SELECT MIN(p2.id)
        FROM posts p2
        WHERE p2.topic_id = ${topic_id}
          AND p2.type = ${post_type}
          AND p2.is_hidden = false
      )
    ) post_id
    FROM posts p
    WHERE
      p.id > (
        SELECT w.watermark_post_id
        FROM topics_users_watermark w
        WHERE w.topic_id = ${topic_id}
          AND w.user_id = ${user_id}
          AND w.post_type = ${post_type}
      )
      AND p.topic_id = ${topic_id}
      AND p.type = ${post_type}
      AND p.is_hidden = false
  `)

  return row && row.post_id
}

////////////////////////////////////////////////////////////

exports.findFirstUnreadPostId = async function ({topic_id, post_type, user_id}) {
  debug(`[findFirstUnreadPostId] topic_id=%j, post_type=%j, user_id=%j`,
        topic_id, post_type, user_id)
  assert(user_id)
  assert(topic_id)
  assert(post_type)

  const row = await pool.one(sql`
SELECT COALESCE(MIN(p.id),
  CASE ${post_type}::post_type
    WHEN 'ic' THEN
      (SELECT t.latest_ic_post_id FROM topics t WHERE t.id = ${topic_id})
    WHEN 'ooc' THEN
      (SELECT COALESCE(t.latest_ooc_post_id, t.latest_post_id) FROM topics t WHERE t.id = ${topic_id})
    WHEN 'char' THEN
      (SELECT t.latest_char_post_id FROM topics t WHERE t.id = ${topic_id})
  END
) post_id
FROM posts p
WHERE
  p.id > COALESCE(
    (
      SELECT w.watermark_post_id
      FROM topics_users_watermark w
      WHERE w.topic_id = ${topic_id}
        AND w.user_id = ${user_id}
        AND w.post_type = ${post_type}
    ),
    0
  )
  AND p.topic_id = ${topic_id}
  AND p.type = ${post_type}
  `)

  return row && row.post_id
}

exports.deleteNotificationForUserIdAndId = async function (userId, id) {
  debug(`[deleteNotificationsForUserIdAndId] userId=${userId}, id=${id}`)

  assert(Number.isInteger(userId))
  assert(Number.isInteger(id))

  return pool.query(sql`
    DELETE FROM notifications
    WHERE to_user_id = ${userId}
      AND id = ${id}
  `)
}

exports.findNotificationById = async function (id) {
  debug(`[findNotification] id=${id}`)
  return pool.one(sql`
    SELECT *
    FROM notifications
    WHERE id = ${id}
  `)
}

////////////////////////////////////////////////////////////

// - inserted_by is user_id of ARENA_MOD that is adding this outcome
exports.createArenaOutcome = async function (topic_id, user_id, outcome, inserted_by) {
  assert(_.isNumber(topic_id))
  assert(_.isNumber(user_id))
  assert(['WIN', 'LOSS', 'DRAW'].includes(outcome))
  assert(_.isNumber(inserted_by))

  let profit
  switch (outcome) {
  case 'WIN':
    profit = 100
    break
  case 'DRAW':
    profit = 50
    break
  case 'LOSS':
    profit = 0
    break
  default:
    throw new Error('Unhandled outcome: ' + outcome)
  }

  return pool.one(sql`
    INSERT INTO arena_outcomes (topic_id, user_id, outcome, profit, inserted_by)
    VALUES (${topic_id}, ${user_id}, ${outcome}, ${profit}, ${inserted_by})
    RETURNING *
  `)
};

////////////////////////////////////////////////////////////

exports.deleteArenaOutcome = async function (topic_id, outcome_id) {
  assert(_.isNumber(topic_id))
  assert(_.isNumber(outcome_id))

  return pool.query(sql`
    DELETE FROM arena_outcomes
    WHERE topic_id = ${topic_id}
      AND id = ${outcome_id}
  `)
}

////////////////////////////////////////////////////////////

// Query is more complex than necessary to make it idempotent
exports.promoteArenaRoleplayToRanked = async function (topic_id) {
  assert(_.isNumber(topic_id))

  return pool.many(sql`
    UPDATE topics
    SET is_ranked = true
    WHERE
      id = ${topic_id}
      AND is_ranked = false
      AND EXISTS (
        SELECT 1
        FROM forums
        WHERE
          is_arena_rp = true
          AND id = (SELECT forum_id FROM topics WHERE id = ${topic_id})
      )
    RETURNING *
  `)
}

// Returns the current feedback topic only if:
// - User has not already replied to it (or clicked ignore)
exports.findUnackedFeedbackTopic = function (feedback_topic_id, user_id) {
  assert(_.isNumber(feedback_topic_id))
  assert(_.isNumber(user_id))

  return pool.one(sql`
    SELECT *
    FROM feedback_topics
    WHERE
      id = ${feedback_topic_id}
      AND NOT EXISTS (
        SELECT 1
        FROM feedback_replies fr
        WHERE fr.feedback_topic_id = ${feedback_topic_id}
          AND fr.user_id = ${user_id}
      )
  `)
}

////////////////////////////////////////////////////////////

exports.findFeedbackTopicById = async function (ftopic_id) {
  assert(_.isNumber(ftopic_id))

  return pool.one(sql`
    SELECT feedback_topics.*
    FROM feedback_topics
    WHERE id = ${ftopic_id}
  `)
}

////////////////////////////////////////////////////////////

exports.findFeedbackRepliesByTopicId = async function (ftopic_id) {
  assert(_.isNumber(ftopic_id))

  return pool.many(sql`
    SELECT
      fr.*,
      u.uname
    FROM feedback_replies fr
    JOIN users u ON fr.user_id = u.id
    WHERE fr.feedback_topic_id = ${ftopic_id}
    ORDER BY id DESC
  `)
}

////////////////////////////////////////////////////////////

exports.insertReplyToUnackedFeedbackTopic = async function (feedback_topic_id, user_id, text, ignored) {
  assert(_.isNumber(feedback_topic_id))
  assert(_.isNumber(user_id))
  assert(_.isBoolean(ignored))

  return pool.one(sql`
    INSERT INTO feedback_replies (user_id, ignored, text, feedback_topic_id)
    VALUES (${user_id}, ${ignored}, ${text}, ${feedback_topic_id})
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

// Defaults to the most active 10 friends
exports.findFriendshipsForUserId = async function (user_id, limit = 100) {
  assert(_.isNumber(user_id))

  return pool.many(sql`
SELECT
  friendships.*,
  json_build_object(
    'uname', u1.uname,
    'last_online_at', u1.last_online_at,
    'avatar_url', u1.avatar_url,
    'slug', u1.slug,
    'is_ghost', u1.is_ghost
  ) "to_user"
FROM friendships
JOIN users u1 ON friendships.to_user_id = u1.id
WHERE from_user_id = ${user_id}
ORDER BY u1.last_online_at DESC NULLS LAST
LIMIT ${limit}
  `)
}

// @fast
exports.findFriendshipBetween = async function (from_id, to_id) {
  return pool.one(sql`
    SELECT friendships
    FROM friendships
    WHERE from_user_id = ${from_id} AND to_user_id = ${to_id}
  `)
}

////////////////////////////////////////////////////////////

exports.createFriendship = async function (from_id, to_id) {
  assert(_.isNumber(from_id))
  assert(_.isNumber(to_id))

  return pool.query(sql`
    INSERT INTO friendships (from_user_id, to_user_id)
    VALUES (${from_id}, ${to_id})
  `).catch((err) => {
    // Ignore unique violation, like if user double-clicks
    // the add-friend button
    if (err.code === '23505') {
      return
    }
    throw err
  })
}

exports.deleteFriendship = async function (from_id, to_id) {
  assert(_.isNumber(from_id))
  assert(_.isNumber(to_id))

  return pool.query(sql`
    DELETE FROM friendships
    WHERE from_user_id = ${from_id} AND to_user_id = ${to_id}
  `)
}

////////////////////////////////////////////////////////////

// Returns array of all unique user IDs that have posted a VM
// in a thread, given the root VM ID of that thread
exports.getVmThreadUserIds = async function (parentVmId) {
  assert(Number.isInteger(parentVmId))

  return pool.many(sql`
    SELECT DISTINCT from_user_id
    FROM vms
    WHERE id = ${parentVmId}
       OR parent_vm_id = ${parentVmId}
  `).then((rows) => rows.map((row) => row.from_user_id))
}

// data:
// - to_user_id: Int
// - from_user_id: Int
// - markup
// - html
// Optional
// - parent_vm_id: Int - Only present if this VM is a reply to a toplevel VM
exports.createVm = async function (data) {
  assert(Number.isInteger(data.from_user_id))
  assert(Number.isInteger(data.to_user_id))
  assert(_.isString(data.markup))
  assert(_.isString(data.html))

  return pool.one(sql`
INSERT INTO vms (from_user_id, to_user_id, markup, html, parent_vm_id)
VALUES (${data.from_user_id},
 ${data.to_user_id}, ${data.markup}, ${data.html}, ${data.parent_vm_id})
RETURNING *
  `)
}

exports.findLatestVMsForUserId = async function (user_id) {
  assert(Number.isInteger(user_id))

  // Created index for this: create index vms_apple ON vms (to_user_id, parent_vm_id)
  return pool.many(sql`
SELECT
  vms.*,
  json_build_object(
    'uname', u.uname,
    'slug', u.slug,
    'avatar_url', u.avatar_url,
    'role', u.role
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
          'url', '/users/' || u2.slug,
          'role', u2.role
        ) "from_user"
      FROM vms vms2
      JOIN users u2 ON vms2.from_user_id = u2.id
      WHERE vms2.parent_vm_id = vms.id
    ) sub
  ) child_vms
FROM vms
JOIN users u ON vms.from_user_id = u.id
WHERE vms.to_user_id = ${user_id} AND parent_vm_id IS NULL
ORDER BY vms.id DESC
LIMIT 30
  `)
}

exports.clearVmNotification = async function (to_user_id, vm_id) {
  assert(Number.isInteger(to_user_id))
  assert(Number.isInteger(vm_id))

  return pool.query(sql`
    DELETE FROM notifications
    WHERE to_user_id = ${to_user_id} AND vm_id = ${vm_id}
  `)
}

////////////////////////////////////////////////////////////
// current_sidebar_contests

exports.clearCurrentSidebarContest = async function () {
  return pool.query(sql`
    UPDATE current_sidebar_contests
    SET is_current = false
  `)
}

exports.updateCurrentSidebarContest = async function (id, data) {
  assert(Number.isInteger(id))
  assert(_.isString(data.title) || _.isUndefined(data.title))
  assert(_.isString(data.topic_url) || _.isUndefined(data.topic_url))
  assert(_.isString(data.deadline) || _.isUndefined(data.deadline))
  assert(_.isString(data.image_url) || _.isUndefined(data.image_url))
  assert(_.isString(data.description) || _.isUndefined(data.description))
  assert(_.isBoolean(data.is_current) || _.isUndefined(data.is_current))

  // Reminder: Only COALESCE things that are not nullable
  return pool.one(sql`
    UPDATE current_sidebar_contests
    SET
      title       = COALESCE(${data.title}, title),
      topic_url   = COALESCE(${data.topic_url}, topic_url),
      deadline    = COALESCE(${data.deadline}, deadline),
      image_url   = ${data.image_url},
      description = ${data.description},
      is_current  = COALESCE(${data.is_current}, is_current)
    WHERE id = ${id}
    RETURNING *
  `)
}

exports.insertCurrentSidebarContest = async function (data) {
  assert(_.isString(data.title))
  assert(_.isString(data.topic_url))
  assert(_.isString(data.deadline))
  assert(_.isString(data.image_url) || _.isUndefined(data.image_url))
  assert(_.isString(data.description) || _.isUndefined(data.description))

  return pool.one(sql`
    INSERT INTO current_sidebar_contests
    (title, topic_url, deadline, image_url, description, is_current)
    VALUES
    (${data.title}, ${data.topic_url}, ${data.deadline},
     ${data.image_url}, ${data.description}, true)
    RETURNING *
  `)
}

// Returns object or undefined
exports.getCurrentSidebarContest = async function () {
  return pool.one(sql`
    SELECT *
    FROM current_sidebar_contests
    WHERE is_current = true
    ORDER BY id DESC
    LIMIT 1
  `)
}

// Grabs info necessary to show the table on /arena-fighters
//
// TODO: Replace getminileaderboard with this, just
// pass in a limit
exports.getArenaLeaderboard = async function (limit = 1000) {
  assert(Number.isInteger(limit))

  return pool.many(sql`
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
    LIMIT ${limit}
  `)
}


////////////////////////////////////////////////////////////

exports.updateConvoFolder = async function (userId, convoId, folder) {
  assert(Number.isInteger(userId))
  assert(convoId)
  assert(_.isString(folder))

  return pool.query(sql`
    UPDATE convos_participants
    SET folder = ${folder}
    WHERE user_id = ${userId}
      AND convo_id = ${convoId}
  `)
}

////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////
// NUKING
////////////////////////////////////////////////////////////

// Remember to also approve an unnuked user. Didn't do it
// here because i don't currently pass in unnuker_id
exports.unnukeUser = async function (userId) {
  assert(Number.isInteger(userId))
  const sqls = {
    unbanUser: sql`
      UPDATE users
      SET role = 'member'
        , is_nuked = false
      WHERE id = ${userId}
    `,
    unhideTopics: sql`
      UPDATE topics SET is_hidden = false WHERE user_id = ${userId}
    `,
    unhidePosts: sql`
      UPDATE posts SET is_hidden = false WHERE user_id = ${userId}
    `,
    deleteFromNukelist: sql`
      DELETE FROM nuked_users
      WHERE user_id = ${userId}
    `
  };
  return pool.withTransaction(async (client) => {
    await client.query(sqls.unbanUser)
    await client.query(sqls.unhideTopics)
    await client.query(sqls.unhidePosts)
    await client.query(sqls.deleteFromNukelist)
  })
};

// In one fell motion, bans a user, hides all their stuff.
//
// Takes an object to prevent mistakes.
// { spambot: UserId, nuker: UserId  }
exports.nukeUser = async function ({spambot, nuker}) {
  assert(Number.isInteger(spambot))
  assert(Number.isInteger(nuker))

  const sqls = {
    banUser: sql`
      UPDATE users
      SET role = 'banned'
        , is_nuked = true
      WHERE id = ${spambot}
    `,
    hideTopics: sql`
      UPDATE topics SET is_hidden = true WHERE user_id = ${spambot}
    `,
    hidePosts: sql`
      UPDATE posts SET is_hidden = true WHERE user_id = ${spambot}
    `,
    insertNukelist: sql`
      INSERT INTO nuked_users (user_id, nuker_id)
      VALUES (${spambot}, ${nuker})
    `,
    // Update the latest_post_id of every topic
    // that the nuked user has a latest post in
    //
    // TODO: Undo this in `unnukeUser`.
    //
    // FIXME: This is too slow.
    updateTopics: sql`
      UPDATE topics
      SET
        latest_post_id = sub2.latest_post_id
      FROM (
        SELECT sub.topic_id, MAX(posts.id) latest_post_id
        FROM posts
        JOIN (
          SELECT t.id topic_id
          FROM posts p
          JOIN topics t ON p.id = t.latest_post_id
          WHERE p.user_id = ${spambot}
        ) sub on posts.topic_id = sub.topic_id
        WHERE posts.is_hidden = false
        GROUP BY sub.topic_id
      ) sub2
      WHERE id = sub2.topic_id
    `
  }

  return pool.withTransaction(async (client) => {
    await client.query(sqls.banUser)
    await client.query(sqls.hideTopics)
    await client.query(sqls.hidePosts)
    await client.query(sqls.insertNukelist)
    //await client.query(sqls.updateTopics)
  })
  .catch((err) => {
    if (err.code === '23505') {
      throw 'ALREADY_NUKED'
    }
    throw err
  })
};

////////////////////////////////////////////////////////////

// Delete topic ban for given topic+user combo
exports.deleteUserTopicBan = async (topicId, userId) => {
  assert(Number.isInteger(topicId))
  assert(Number.isInteger(userId))

  return pool.query(sql`
    DELETE FROM topic_bans
    WHERE topic_id = ${topicId}
      AND banned_id = ${userId}
  `)
}

exports.deleteTopicBan = async (banId) => {
  assert(Number.isInteger(banId))

  return pool.query(sql`
    DELETE FROM topic_bans
    WHERE id = ${banId}
  `)
}

exports.getTopicBan = async (banId) => {
  assert(Number.isInteger(banId))

  return pool.one(sql`
    SELECT
      tb.*,
      json_build_object(
        'id', u1.id,
        'uname', u1.uname,
        'slug', u1.slug
      ) banned_by,
      json_build_object(
        'id', u2.id,
        'uname', u2.uname,
        'slug', u2.slug
      ) banned
    FROM topic_bans tb
    JOIN users u1 ON u1.id = tb.banned_by_id
    JOIN users u2 ON u2.id = tb.banned_id
    WHERE tb.id = ${banId}
  `)
}

exports.insertTopicBan = async (topicId, gmId, bannedId) => {
  assert(Number.isInteger(topicId))
  assert(Number.isInteger(gmId))
  assert(Number.isInteger(bannedId))

  return pool.query(sql`
    INSERT INTO topic_bans (topic_id, banned_by_id, banned_id)
    VALUES (${topicId}, ${gmId}, ${bannedId})
  `).catch((err) => {
    if (err.code === '23505') {
      return
    }
    throw err
  })
}

exports.listTopicBans = async (topicId) => {
  assert(Number.isInteger(topicId))

  return pool.many(sql`
    SELECT
      tb.*,
      json_build_object(
        'id', u1.id,
        'uname', u1.uname,
        'slug', u1.slug
      ) banned_by,
      json_build_object(
        'id', u2.id,
        'uname', u2.uname,
        'slug', u2.slug
      ) banned
    FROM topic_bans tb
    JOIN users u1 ON u1.id = tb.banned_by_id
    JOIN users u2 ON u2.id = tb.banned_id
    WHERE tb.topic_id = ${topicId}
  `)
}

exports.allForumMods = async () => {
  return pool.many(sql`
    SELECT
      fm.forum_id,
      json_build_object(
        'id', u.id,
        'uname', u.uname,
        'slug', u.slug
      ) "user"
    FROM users u
    JOIN forum_mods fm ON u.id = fm.user_id
  `)
}

// Re-exports

exports.keyvals = require('./keyvals')
exports.ratelimits = require('./ratelimits')
exports.images = require('./images')
exports.dice = require('./dice')
exports.profileViews = require('./profile-views')
exports.users = require('./users')
exports.chat = require('./chat')
exports.subscriptions = require('./subscriptions')
exports.vms = require('./vms')
exports.convos = require('./convos')
exports.tags = require('./tags')
