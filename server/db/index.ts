// 3rd party
import _ from "lodash";
import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db");
import pgArray from "postgres-array";
import { v7 as uuidv7 } from "uuid";
// 1st party
import * as config from "../config";
import * as belt from "../belt";
import * as pre from "../presenters";
import {
  pool,
  maybeOneRow,
  exactlyOneRow,
  PgClientInTransaction,
} from "./util";
import { Client, Pool, PoolClient } from "pg";
import * as revs from "./revs";
import { Context } from "koa";
import {
  DbConvo,
  DbNotification,
  DbPm,
  DbRatingType,
  DbSession,
  DbTag,
  DbTopic,
  DbUser,
  DbVm,
} from "../dbtypes";

// TODO: db fns should take this as an argument esp if they can be used inside/outside txns
export type PgQueryExecutor = Pool | PoolClient | Client;

// jun-12-2025: another bit of code archaelogy!
//
// Wraps generator function in one that prints out the execution time
// when app is run in development mode.
// function wrapTimer(fn) {
//     if (config.NODE_ENV !== 'development') return fn
//     else
//         return function*() {
//             var start = Date.now()
//             var result = yield fn.apply(this, arguments)
//             var diff = Date.now() - start
//             debug('[%s] Executed in %sms', fn.name, diff)
//             return result
//         }
// }

export async function updatePostStatus(
  postId: number,
  status: "hide" | "unhide",
) {
  const STATUS_WHITELIST = ["hide", "unhide"];
  assert(STATUS_WHITELIST.includes(status));

  let isHidden;
  switch (status) {
    case "hide":
      isHidden = true;
      break;
    case "unhide":
      isHidden = false;
      break;
    default:
      throw new Error("Invalid status " + status);
  }

  return pool
    .query(
      `
    UPDATE posts
    SET is_hidden = $1
    WHERE id = $2
    RETURNING *
  `,
      [isHidden, postId],
    )
    .then(maybeOneRow);
}

export async function updateTopicStatus(
  topicId: number,
  status: "stick" | "unstick" | "hide" | "unhide" | "close" | "open",
) {
  const STATUS_WHITELIST = [
    "stick",
    "unstick",
    "hide",
    "unhide",
    "close",
    "open",
  ];
  assert(STATUS_WHITELIST.includes(status));

  let a;
  let b;
  let c;

  switch (status) {
    case "stick":
      [a, b, c] = [true, null, null];
      break;
    case "unstick":
      [a, b, c] = [false, null, null];
      break;
    case "hide":
      [a, b, c] = [null, true, null];
      break;
    case "unhide":
      [a, b, c] = [null, false, null];
      break;
    case "close":
      [a, b, c] = [null, null, true];
      break;
    case "open":
      [a, b, c] = [null, null, false];
      break;
    default:
      throw new Error("Invalid status " + status);
  }

  return pool
    .query(
      `
    UPDATE topics
    SET is_sticky = COALESCE($1, is_sticky),
        is_hidden = COALESCE($2, is_hidden),
        is_closed = COALESCE($3, is_closed)
    WHERE id = $4
    RETURNING *
  `,
      [a, b, c, topicId],
    )
    .then(maybeOneRow);
}

// Same as findTopic but takes a userid so that it can return a topic
// with an is_subscribed boolean for the user
// Keep in sync with db.findTopicById
export const findTopicWithIsSubscribed = async function (userId, topicId) {
  debug("[findTopicWithIsSubscribed] userId %s, topicId %s:", userId, topicId);

  return pool
    .query(
      `
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
      (SELECT json_agg(tb.banned_id) FROM topic_bans tb WHERE tb.topic_id = t.id) banned_ids,
      (
      SELECT json_agg(tags.*)
      FROM tags
      JOIN tags_topics ON tags.id = tags_topics.tag_id
      WHERE tags_topics.topic_id = t.id
      ) tags
    FROM topics t
    JOIN forums f ON t.forum_id = f.id
    LEFT OUTER JOIN topic_subscriptions ts ON t.id = ts.topic_id AND ts.user_id = $1
    WHERE t.id = $2
    GROUP BY t.id, f.id, ts.user_id
  `,
      [userId, topicId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export async function updateUserBio(
  userId: number,
  bioMarkup: string,
  bioHtml: string,
) {
  assert(_.isString(bioMarkup));

  return pool
    .query(
      `
    UPDATE users
    SET bio_markup = $1, bio_html = $2
    WHERE id = $3
    RETURNING *
  `,
      [bioMarkup, bioHtml, userId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function findTopic(topicId: number) {
  return pool
    .query(
      `
    SELECT
      t.*,
      to_json(f.*) "forum"
    FROM topics t
    JOIN forums f ON t.forum_id = f.id
    WHERE t.id = $1
  `,
      [topicId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function deleteResetTokens(userId: number) {
  assert(_.isNumber(userId));

  return pool.query(
    `
    DELETE FROM reset_tokens
    WHERE user_id = $1
  `,
    [userId],
  );
}

////////////////////////////////////////////////////////////

export const findLatestActiveResetToken = async function (userId) {
  assert(_.isNumber(userId));

  return pool
    .query(
      `
    SELECT *
    FROM active_reset_tokens
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `,
      [userId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const createResetToken = async function (userId) {
  debug("[createResetToken] userId: " + userId);

  const uuid = uuidv7();

  return pool
    .query(
      `
    INSERT INTO reset_tokens (user_id, token)
    VALUES ($1, $2)
    RETURNING *
  `,
      [userId, uuid],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findUserById = async function (id) {
  return pool
    .query(
      `
    SELECT * FROM users WHERE id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export async function findUserBySlug(
  slug: string,
): Promise<DbUser | undefined> {
  debug(`[findUserBySlug] slug=%j`, slug);
  assert(_.isString(slug));

  slug = slug.toLowerCase();

  let user = pool
    .query<DbUser>(
      `
    SELECT u.*
    FROM users u
    WHERE u.slug = $1
       OR id = (
         SELECT user_id
         FROM unames
         WHERE slug = $2
           AND recycle = false
       )
  `,
      [slug, slug],
    )
    .then(maybeOneRow);
  if (user && user.id){
      //Get all users from the database where the user ID is any account owned by the same user as our account
      const altList = await pool.query(`SELECT json_agg(users.* ORDER BY users.uname ASC)
      FROM users
      WHERE id IN (SELECT
        id
        FROM alts
        WHERE owner_id = (
          SELECT owner_id
          FROM alts
          WHERE id = ${user.id}
        )
        AND id != ${user.id}
      )`).then(maybeOneRow);
      user.alts = altList.json_agg;
  }

  return user
};

////////////////////////////////////////////////////////////

// Only use this if you need ratings table, else use just findUserBySlug
export const findUserWithRatingsBySlug = async function (slug) {
  debug(`[findUserWithRatingsBySlug] slug=%j`, slug);
  assert(typeof slug === "string");

  slug = slug.toLowerCase();

  return pool
    .query(
      `
    WITH u1 AS (
      SELECT *
      FROM users
      WHERE slug = $1
         OR id = (
           SELECT user_id
           FROM unames
           WHERE slug = $2
             AND recycle = false
         )
    ),
    q1 AS (
      SELECT
        COUNT(r) FILTER (WHERE r.type = 'like') like_count,
        COUNT(r) FILTER (WHERE r.type = 'laugh') laugh_count,
        COUNT(r) FILTER (WHERE r.type = 'thank') thank_count
      FROM ratings r
      JOIN u1 ON r.to_user_id = u1.id
    ),
    q2 AS (
      SELECT
        COUNT(r) FILTER (WHERE r.type = 'like') like_count,
        COUNT(r) FILTER (WHERE r.type = 'laugh') laugh_count,
        COUNT(r) FILTER (WHERE r.type = 'thank') thank_count
      FROM ratings r
      JOIN u1 ON r.from_user_id = u1.id
    )

    SELECT
      *,
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
    FROM users
    WHERE id = (SELECT id FROM u1)
  `,
      [slug, slug],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Also tries historical unames
export const findUserByUnameOrEmail = async function (unameOrEmail) {
  assert(_.isString(unameOrEmail));

  const slug = belt.slugifyUname(unameOrEmail);

  return pool
    .query(
      `
    SELECT *
    FROM users u
    WHERE u.slug = $1
       OR lower(u.email) = lower($2)
       OR id = (
         SELECT user_id
         FROM unames
         WHERE slug = $3
           AND recycle = false
       )
  `,
      [slug, unameOrEmail, slug],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Note: Case-insensitive
export const findUserByEmail = async function (email) {
  debug("[findUserByEmail] email: " + email);

  return pool
    .query(
      `
    SELECT *
    FROM users u
    WHERE lower(u.email) = lower($1);
  `,
      [email],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Note: Case-insensitive
export const findUserByUname = async function (uname) {
  debug("[findUserByUname] uname: " + uname);

  const slug = belt.slugifyUname(uname);

  return pool
    .query(
      `
    SELECT *
    FROM users
    WHERE slug = $1
  `,
      [slug],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// `beforeId` is undefined or a number
export const findRecentPostsForUserId = async function (userId, beforeId) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));

  return pool
    .query(
      `
    SELECT
      p.*,
      to_json(t.*) "topic",
      to_json(f.*) "forum"
    FROM posts p
    JOIN topics t ON p.topic_id = t.id
    JOIN forums f ON t.forum_id = f.id
    WHERE p.user_id = $1 AND p.id < $2
    ORDER BY p.id DESC
    LIMIT $3
  `,
      [userId, beforeId || 1e9, config.RECENT_POSTS_PER_PAGE],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

// `beforeId` is undefined or a number
export const findRecentTopicsForUserId = async function (userId, beforeId) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));

  return pool
    .query(
      `
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
    WHERE t.user_id = $1 AND t.id < $2
    GROUP BY t.id, f.id, p.id
    ORDER BY t.id DESC
    LIMIT $3
  `,
      [userId, beforeId || 1e9, config.RECENT_POSTS_PER_PAGE],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export const _findUser = async function (userId) {
  debug("[findUser] userId: " + userId);

  return pool
    .query(
      `
    SELECT *
    FROM users
    WHERE id = $1
  `,
      [userId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Returns an array of Users
// (Case insensitive uname lookup)
export async function findUsersByUnames(unames: string[]) {
  assert(_.isArray(unames));
  assert(_.every(unames, _.isString));

  unames = unames.map((s) => s.toLowerCase());

  return pool
    .query<DbUser>(
      `
    SELECT u.*
    FROM users u
    WHERE lower(u.uname) = ANY ($1::text[])
  `,
      [unames],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

// If toUsrIds is not given, then it's a self-convo
// TODO: Wrap in transaction, Document the args of this fn
export async function createConvo(
  pgClient: PgClientInTransaction,
  args: {
    userId: number;
    toUserIds: number[];
    title: string;
    markup: string;
    html: string;
    ipAddress: string;
  },
) {
  debug("[createConvo] args: ", args);
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(_.isNumber(args.userId));
  assert(_.isUndefined(args.toUserIds) || _.isArray(args.toUserIds));
  assert(_.isString(args.title));
  assert(_.isString(args.markup));
  assert(_.isString(args.html));

  // Create convo
  const convo = await pgClient
    .query<DbConvo>(
      `
      INSERT INTO convos (user_id, title)
      VALUES ($1, $2)
      RETURNING *
    `,
      [args.userId, args.title],
    )
    .then(exactlyOneRow);

  // Insert participants and the PM in parallel

  const tasks = args.toUserIds
    .map((toUserId) => {
      // insert each receiving participant
      return pgClient.query(
        `
        INSERT INTO convos_participants (convo_id, user_id)
        VALUES ($1, $2)
      `,
        [convo.id, toUserId],
      );
    })
    .concat([
      // insert the sending participant
      pgClient.query(
        `
        INSERT INTO convos_participants (convo_id, user_id)
        VALUES ($1, $2)
      `,
        [convo.id, args.userId],
      ),
      // insert the PM
      pgClient.query(
        `
        INSERT INTO pms
          (convo_id, user_id, ip_address, markup, html, idx)
        VALUES (
          $1, $2, $3,
          $4, $5,
          0
        )
        RETURNING *
      `,
        [convo.id, args.userId, args.ipAddress, args.markup, args.html],
      ),
    ]);

  const results = await Promise.all(tasks);

  // Assoc firstPm to the returned convo
  (convo as any).firstPm = _.last(results).rows[0];
  convo.pms_count++; // This is a stale copy so we need to manually inc
  return convo;
}

////////////////////////////////////////////////////////////

// Only returns user if reset token has not expired
// so this can be used to verify tokens
export const findUserByResetToken = function (resetToken) {
  // Short circuit if it's not even a UUID
  if (!belt.isValidUuid(resetToken)) {
    return;
  }

  return pool
    .query(
      `
    SELECT *
    FROM users u
    WHERE u.id = (
      SELECT rt.user_id
      FROM active_reset_tokens rt
      WHERE rt.token = $1
    )
  `,
      [resetToken],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findUserBySessionId = async function (sessionId) {
  assert(belt.isValidUuid(sessionId));

  const user = await pool
    .query(
      `
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
  `,
      [sessionId],
    )
    .then(maybeOneRow);

  if (user && user.roles) {
    user.roles = pgArray.parse(user.roles, _.identity);
  }

   if (user && user.id){
    //Get all users from the database where the user ID is any account owned by the same user as our account
    const altList = await pool.query(`SELECT json_agg(users.* ORDER BY users.uname ASC)
    FROM users
    WHERE id IN (SELECT
      id
      FROM alts
      WHERE owner_id = (
        SELECT owner_id
        FROM alts
        WHERE id = $1
      )
      AND id != $1
    )`, [user.id]).then(maybeOneRow);
    user.alts = altList.json_agg
  }

  return user;
};

////////////////////////////////////////////////////////////

export async function createSession(
  pgClient: PgQueryExecutor,
  props: {
    userId: number;
    ipAddress: string;
    interval: string;
  },
) {
  debug("[createSession] props: ", props);
  assert(typeof props.userId === "number");
  assert(typeof props.ipAddress === "string");
  assert(typeof props.interval === "string");

  const uuid = uuidv7();

  return pgClient
    .query<DbSession>(
      `
    INSERT INTO sessions (user_id, id, ip_address, expired_at)
    VALUES ($1, $2, $3::inet,
      NOW() + $4::interval)
    RETURNING *
  `,
      [props.userId, uuid, props.ipAddress, props.interval],
    )
    .then(exactlyOneRow);
}

////////////////////////////////////////////////////////////

// Sync with db.findTopicsWithHasPostedByForumId
export const findTopicsByForumId = async function (
  forumId,
  limit,
  offset,
  canViewHidden,
) {
  debug(
    "[%s] forumId: %s, limit: %s, offset: %s",
    "findTopicsByForumId",
    forumId,
    limit,
    offset,
  );

  return pool
    .query(
      `
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
  ) tags
FROM topics t
JOIN users u ON t.user_id = u.id
LEFT JOIN posts p ON t.latest_post_id = p.id
LEFT JOIN users u2 ON p.user_id = u2.id
LEFT JOIN forums f ON t.forum_id = f.id
WHERE t.forum_id = $1
  AND ($2 OR t.is_hidden = false)
ORDER BY t.is_sticky DESC, t.latest_post_at DESC
LIMIT $3
OFFSET $4
  `,
      [forumId, canViewHidden, limit, offset],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

// Sync with db.findTopicsByForumId
// Same as db.findTopicsByForumId except each forum has a has_posted boolean
// depending on whether or not userId has posted in each topic
export const findTopicsWithHasPostedByForumId = async function (
  forumId,
  limit,
  offset,
  userId,
  canViewHidden,
) {
  assert(userId);
  debug(
    "[findTopicsWithHasPostedByForumId] forumId: %s, userId: %s",
    forumId,
    userId,
  );

  return pool
    .query(
      `
SELECT
  EXISTS(
    SELECT 1 FROM posts WHERE topic_id = t.id AND user_id = $1
  ) has_posted,
  (
    SELECT t.latest_post_id > (
      SELECT COALESCE(MAX(w.watermark_post_id), 0)
      FROM topics_users_watermark w
      WHERE w.topic_id = t.id
        AND w.user_id = $2
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
  ) tags
FROM topics t
JOIN users u ON t.user_id = u.id
LEFT JOIN posts p ON t.latest_post_id = p.id
LEFT JOIN users u2 ON p.user_id = u2.id
LEFT JOIN forums f ON t.forum_id = f.id
WHERE t.forum_id = $3
  AND ($4 OR t.is_hidden = false)
ORDER BY t.is_sticky DESC, t.latest_post_at DESC
LIMIT $5
OFFSET $6
  `,
      [userId, userId, forumId, canViewHidden, limit, offset],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export const updateUserPassword = async function (userId, password) {
  assert(_.isNumber(userId));
  assert(_.isString(password));

  const digest = await belt.hashPassword(password);

  return pool
    .query(
      `
    UPDATE users
    SET digest = $1
    WHERE id = $2
    RETURNING *
  `,
      [digest, userId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Keep updatePost and updatePm in sync
//
// Updating a post saves the update as a revision.
//
// reason is optional
export const updatePost = async function (
  userId,
  postId,
  markup,
  html,
  reason,
) {
  assert(Number.isInteger(userId));
  assert(Number.isInteger(postId));
  assert(typeof markup === "string");
  assert(typeof html === "string");
  assert(!reason || typeof reason === "string");

  return pool
    .query(
      `
    WITH rev AS (
      INSERT INTO post_revs (user_id, post_id, markup, html, length, reason)
      VALUES (
        $1, $2, $3, $4, $5, $6
      )
      RETURNING html, markup
    )
    UPDATE posts
    SET markup = rev.markup
      , html = rev.html
      , updated_at = NOW()
    FROM rev
    WHERE posts.id = $7
    RETURNING *
  `,
      [userId, postId, markup, html, Buffer.byteLength(markup), reason, postId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Keep updatePost and updatePm in sync
export const updatePm = async function (id, markup, html) {
  assert(_.isString(markup));
  assert(_.isString(html));

  return pool
    .query(
      `
UPDATE pms
SET markup = $1, html = $2, updated_at = NOW()
WHERE id = $3
RETURNING *
  `,
      [markup, html, id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Attaches topic and forum to post for authorization checks
// See cancan.js 'READ_POST'
export const findPostWithTopicAndForum = async function (postId) {
  return pool
    .query(
      `
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum"
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.id = $1
  `,
      [postId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Keep findPost and findPm in sync
export const findPostById = async function (postId) {
  return pool
    .query(
      `
SELECT
  p.*,
  to_json(t.*) "topic",
  to_json(f.*) "forum",
  (SELECT json_agg(tb.banned_id) FROM topic_bans tb WHERE tb.topic_id = t.id) banned_ids
FROM posts p
JOIN topics t ON p.topic_id = t.id
JOIN forums f ON t.forum_id = f.id
WHERE p.id = $1
  `,
      [postId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findPmById = async function findPm(id) {
  return pool
    .query(
      `
SELECT
  pms.*,
  to_json(c.*) "convo"
FROM pms
JOIN convos c ON pms.convo_id = c.id
WHERE pms.id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findUsersContainingString = async function (searchTerm) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm));

  return pool
    .query(
      `
SELECT *
FROM users
WHERE lower(uname) LIKE '%' || lower($1::text) || '%'
ORDER BY id DESC
LIMIT $2::bigint
  `,
      [searchTerm, config.USERS_PER_PAGE],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

// Ignore nuked users
export const paginateUsers = async function (beforeId = 1e9) {
  return pool
    .query(
      `
    SELECT *
    FROM users
    WHERE id < $1
      AND is_nuked = false
    ORDER BY id DESC
    LIMIT $2::bigint
  `,
      [beforeId, config.USERS_PER_PAGE],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export const findUsersContainingStringWithId = async function (
  searchTerm,
  beforeId,
) {
  // searchTerm is the term that the user searched for
  assert(_.isString(searchTerm) || _.isUndefined(searchTerm));

  return pool
    .query(
      `
SELECT *
FROM users
WHERE
lower(uname) LIKE '%' || lower($1::text) || '%'
AND id < $2
ORDER BY id DESC
LIMIT $3::bigint
  `,
      [searchTerm, beforeId, config.USERS_PER_PAGE],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////

export const findPmsByConvoId = async function (convoId, page) {
  const fromIdx = (page - 1) * config.POSTS_PER_PAGE;
  const toIdx = fromIdx + config.POSTS_PER_PAGE;

  return pool
    .query(
      `
SELECT
  pms.*,
  to_json(u.*) "user"
FROM pms
JOIN users u ON pms.user_id = u.id
WHERE pms.convo_id = $1 AND pms.idx >= $2 AND pms.idx < $3
GROUP BY pms.id, u.id
ORDER BY pms.id
  `,
      [convoId, fromIdx, toIdx],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export const findPostsByTopicId = async function (topicId, postType, page) {
  debug(
    "[findPostsByTopicId] topicId: %s, postType: %s, page",
    topicId,
    postType,
    page,
  );
  assert(_.isNumber(page));

  let fromIdx = (page - 1) * config.POSTS_PER_PAGE;
  const toIdx = fromIdx + config.POSTS_PER_PAGE;

  // If on page one, include -1 idx
  if (page === 1) {
    fromIdx = -1;
  }

  debug("%s <= post.idx < %s", fromIdx, toIdx);

  // Don't fetch markup if we don't need it, or any unnecessary
  // html/markup field in general since they can be huge.
  //
  // Trying to be frugal with the projection
  const rows = await pool
    .query(
      `
    SELECT
      p.id,
      p.text,
      p.html,
      p.legacy_html,
      p.topic_id,
      p.user_id,
      p.created_at,
      p.updated_at,
      p.is_roleplay,
      p.type,
      p.ip_address,
      p.is_hidden,
      p.rev_count,
      p.idx,
      json_build_object(
        'id', u.id,
        'uname', u.uname,
        'created_at', u.created_at,
        'last_online_at', u.last_online_at,
        'is_ghost', u.is_ghost,
        'role', u.role,
        'posts_count', u.posts_count,
        'sig_html', u.sig_html,
        'avatar_url', u.avatar_url,
        'slug', u.slug,
        'custom_title', u.custom_title,
        'active_trophy_id' , u.active_trophy_id,
        'has_bio', CASE
            WHEN u.bio_markup IS NULL THEN false
            WHEN char_length(u.bio_markup) > 3 THEN true
            ELSE false
          END
      ) "user",
      to_json(t.*) "topic",
      to_json(f.*) "forum",

      CASE
        WHEN u.current_status_id IS NOT NULL THEN
          json_build_object(
            'html', s.html,
            'created_at', s.created_at
          )
      END "current_status",

      to_json(array_remove(array_agg(r.*), null)) ratings
    FROM posts p
    JOIN users u ON p.user_id = u.id
    JOIN topics t ON p.topic_id = t.id
    JOIN forums f ON t.forum_id = f.id
    LEFT OUTER JOIN ratings r ON p.id = r.post_id
    LEFT OUTER JOIN statuses s ON u.current_status_id = s.id
    WHERE p.topic_id = $1
      AND p.type = $2
      AND p.idx >= $3
      AND p.idx < $4
    GROUP BY p.id, u.id, t.id, f.id, s.id
    ORDER BY p.idx
  `,
      [topicId, postType, fromIdx, toIdx],
    )
    .then((res) => res.rows);

  return rows.map((row) => {
    // Make current_status a property of post.user where it makes more sense
    if (row.current_status) {
      row.current_status.created_at = new Date(row.current_status.created_at);
    }
    row.user.current_status = row.current_status;
    delete row.current_status;
    return row;
  });
};

////////////////////////////////////////////////////////////

// TODO: Order by
// TODO: Pagination
export const findForumWithTopics = async function (forumId) {
  const forum = await pool
    .query(
      `
    SELECT
      f.*,
      to_json(array_agg(t.*)) "topics",
      to_json(p.*) "latest_post"
    FROM forums f
    LEFT OUTER JOIN topics t ON f.id = t.forum_id
    WHERE f.id = $1
    GROUP BY f.id
  `,
      [forumId],
    )
    .then(maybeOneRow);

  if (!forum) return null;

  // The query will set forum.topics to `[null]` if it has
  // none, so compact it to just `[]`.
  forum.topics = _.compact(forum.topics);

  return forum;
};

////////////////////////////////////////////////////////////

// Keep findPostWithTopic and findPmWithConvo in sync
export const findPostWithTopic = async function (postId) {
  return pool
    .query(
      `
    SELECT
      p.*,
      to_json(t.*) "topic"
    FROM posts p
    JOIN topics t ON p.topic_id = t.id
    WHERE p.id = $1
    GROUP BY p.id, t.id
  `,
      [postId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Keep findPostWithTopic and findPmWithConvo in sync
export const findPmWithConvo = async function (pmId) {
  return pool
    .query(
      `
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
  `,
      [pmId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Returns created PM
export async function createPm(
  pgClient: PgClientInTransaction,
  props: {
    userId: number;
    ipAddress: string;
    convoId: number;
    markup: string;
    html: string;
  },
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(_.isNumber(props.userId));
  assert(props.convoId);
  assert(_.isString(props.markup));
  assert(_.isString(props.html));

  return pgClient
    .query<DbPm>(
      `
    INSERT INTO pms (user_id, ip_address, convo_id, markup, html)
    VALUES ($1, $2::inet, $3,
      $4, $5)
    RETURNING *
  `,
      [props.userId, props.ipAddress, props.convoId, props.markup, props.html],
    )
    .then(exactlyOneRow);
}

////////////////////////////////////////////////////////////

// Args:
// - userId      Required Number/String
// - ipAddress   Optional String
// - markup      Required String
// - topicId     Required Number/String
// - type        Required String, ic | ooc | char
// - isRoleplay  Required Boolean
// - idx         Undefined or -1 if it's the tab's wiki post
export async function createPost(pgClient: PgClientInTransaction, args) {
  debug(`[createPost] args:`, args);
  assert(_.isNumber(args.userId));
  assert(_.isString(args.ipAddress));
  assert(_.isString(args.markup));
  assert(_.isString(args.html));
  assert(args.topicId);
  assert(_.isBoolean(args.isRoleplay));
  assert(["ic", "ooc", "char"].includes(args.type));
  assert(args.idx === -1 || typeof args.idx === "undefined");

  const post = await pgClient
    .query(
      `
      INSERT INTO posts
        (user_id, ip_address, topic_id, markup, html, type, is_roleplay, idx)
      VALUES (
        $1, $2::inet,
        $3, $4,
        $5, $6, $7,
        $8
      )
      RETURNING *
    `,
      [
        args.userId,
        args.ipAddress,
        args.topicId,
        args.markup,
        args.html,
        args.type,
        args.isRoleplay,
        args.idx,
      ],
    )
    .then(maybeOneRow);

  await revs.insertPostRev(
    pgClient,
    args.userId,
    post.id,
    args.markup,
    args.html,
  );

  return post;
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
//
export const createTopic = async function (props) {
  debug("[createTopic]", props);
  assert(_.isNumber(props.userId));
  assert(props.forumId);
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.title));
  assert(_.isString(props.markup));
  assert(_.isString(props.html));
  assert(_.isBoolean(props.isRoleplay));
  assert(["ic", "ooc", "char"].includes(props.postType));
  assert(_.isArray(props.tagIds) || _.isUndefined(props.tagIds));
  // Only roleplays have join-status
  if (props.isRoleplay) assert(_.isString(props.joinStatus));
  else assert(_.isUndefined(props.joinStatus));

  return pool.withTransaction(async (client) => {
    // Create topic
    const topic = await client
      .query(
        `
      INSERT INTO topics
        (forum_id, user_id, title, is_roleplay, join_status)
      VALUES ($1, $2, $3,
        $4, $5)
      RETURNING *
    `,
        [
          props.forumId,
          props.userId,
          props.title,
          props.isRoleplay,
          props.joinStatus,
        ],
      )
      .then(maybeOneRow);

    // Create topic's first post
    const post = await client
      .query(
        `
      INSERT INTO posts
        (topic_id, user_id, ip_address, markup, html, type, is_roleplay, idx)
      VALUES ($1, $2, $3::inet,
       $4, $5, $6, $7, 0)
      RETURNING *
    `,
        [
          topic.id,
          props.userId,
          props.ipAddress,
          props.markup,
          props.html,
          props.postType,
          props.isRoleplay,
        ],
      )
      .then(maybeOneRow);

    // Create post revision
    await revs.insertPostRev(
      client,
      props.userId,
      post.id,
      props.markup,
      props.html,
    );

    // Attach post to topic so that it can be passed into antispam process()
    topic.post = post;

    // Create tags if given
    if (props.tagIds) {
      const tasks = props.tagIds.map((tagId) =>
        client.query(
          `
        INSERT INTO tags_topics (topic_id, tag_id)
        VALUES ($1, $2)
      `,
          [topic.id, tagId],
        ),
      );
      await Promise.all(tasks);
    }

    return topic;
  });
};

////////////////////////////////////////////////////////////

// Generic user-update route. Intended to be paired with
// the generic PUT /users/:userId route.
// TODO: Use the knex updater instead
export const updateUser = async (userId, attrs) => {
  debug("[updateUser] attrs", attrs);

  return pool
    .query(
      `
    UPDATE users
    SET
      email = COALESCE($1, email),
      sig = COALESCE($2, sig),
      avatar_url = COALESCE($3, avatar_url),
      hide_sigs = COALESCE($4, hide_sigs),
      is_ghost = COALESCE($5, is_ghost),
      sig_html = COALESCE($6, sig_html),
      custom_title = COALESCE($7, custom_title),
      is_grayscale = COALESCE($8, is_grayscale),
      force_device_width = COALESCE($9, force_device_width),
      hide_avatars = COALESCE($10, hide_avatars),
      email_verified = COALESCE($11, email_verified),
      eflags = COALESCE($12, eflags)
    WHERE id = $13
    RETURNING *
  `,
      [
        attrs.email,
        attrs.sig,
        attrs.avatar_url,
        attrs.hide_sigs,
        attrs.is_ghost,
        attrs.sig_html,
        attrs.custom_title,
        attrs.is_grayscale,
        attrs.force_device_width,
        attrs.hide_avatars,
        attrs.email_verified,
        attrs.eflags,
        userId,
      ],
    )
    .then(maybeOneRow)
    .catch((err) => {
      if (err.code === "23505") {
        if (/"unique_email"/.test(err.toString())) {
          throw "EMAIL_TAKEN";
        }
      }
      throw err;
    });
};

////////////////////////////////////////////////////////////

export const updateUserRole = async function (userId, role) {
  return pool
    .query(
      `
    UPDATE users
    SET role = $1
    WHERE id = $2
    RETURNING *
  `,
      [role, userId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// @fast
export const findForumById = async function (forumId) {
  return pool
    .query(
      `
    SELECT
      f.*,
      to_json(f2.*) "child_forum",
      to_json(f3.*) "parent_forum"
    FROM forums f
    LEFT OUTER JOIN forums f2 ON f.id = f2.parent_forum_id
    LEFT OUTER JOIN forums f3 ON f.parent_forum_id = f3.id
    WHERE f.id = $1
    GROUP BY f.id, f2.id, f3.id
  `,
      [forumId],
    )
    .then(maybeOneRow);
};

export const findForum2 = async function (forumId) {
  assert(Number.isInteger(forumId));

  // - child_forums are a list of forums that point to this one
  // - sibling_forums are all children at this level including curr forum

  return pool
    .query(
      `
    SELECT
      f.*,
      (
        SELECT COALESCE(json_agg(forums.*), '[]')
        FROM forums
        WHERE parent_forum_id = $1
      ) "child_forums",
      (
        SELECT COALESCE(json_agg(forums.*), '[]')
        FROM forums
        WHERE parent_forum_id = f.parent_forum_id
           OR id = f.id
      ) "sibling_forums",
      (
        SELECT to_json(forums.*)
        FROM forums
        WHERE id = f.parent_forum_id
      ) "parent_forum"
    FROM forums f
    WHERE f.id = $2
    GROUP BY f.id
  `,
      [forumId, forumId],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// TODO: This should be moved to some admin namespace since
// it includes the nuke info
export const findLatestUsers = async function (limit = 25) {
  debug(`[findLatestUsers]`);
  return pool
    .query(
      `
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
    LIMIT $1
  `,
      [limit],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

// Also has cat.forums array
export const findModCategory = async function () {
  debug(`[findModCategory]`);
  const MOD_CATEGORY_ID = 4;
  return pool
    .query(
      `
    SELECT c.*
    FROM categories c
    WHERE c.id = $1
  `,
      [MOD_CATEGORY_ID],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Only returns non-mod-forum categories
export const findCategories = async function () {
  return pool
    .query(
      `
    SELECT c.*
    FROM categories c
    ORDER BY c.pos
  `,
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export const findCategoriesWithForums = async function () {
  const categories = await pool
    .query(
      `
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
WHERE f.is_hidden = false AND c.pos >= 0
GROUP BY c.id
ORDER BY c.pos
  `,
    )
    .then((res) => res.rows);

  categories.forEach((c) => {
    c.forums = _.sortBy(c.forums, "pos");
  });

  return categories;
};

////////////////////////////////////////////////////////////

// Creates a user and a session (logs them in).
// - Returns {:user <User>, :session <Session>}
// - Use `createUser` if you only want to create a user.
//
// Throws: 'UNAME_TAKEN', 'EMAIL_TAKEN'
export async function createUserWithSession(props: {
  uname: string;
  ipAddress: string;
  password: string;
  email: string;
}): Promise<{ user: DbUser; session: DbSession }> {
  debug("[createUserWithSession] props: ", props);
  assert(_.isString(props.uname));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.password));
  assert(_.isString(props.email));

  const digest = await belt.hashPassword(props.password);
  const slug = belt.slugifyUname(props.uname);

  return pool.withTransaction(async (client) => {
    // Ensure uname doesn't exist in history
    const history = await client
      .query(
        `
      SELECT 1
      FROM unames
      WHERE slug = $1
        AND recycle = false
    `,
        [slug],
      )
      .then(maybeOneRow);

    if (history) {
      throw "UNAME_TAKEN";
    }

    let user;

    try {
      user = await client
        .query<DbUser>(
          `
        INSERT INTO users (uname, digest, email, slug, hide_sigs)
        VALUES ($1, $2, $3, $4, true)
        RETURNING *
      `,
          [props.uname, digest, props.email, slug],
        )
        .then(exactlyOneRow);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "23505") {
        if (/unique_username/.test(err.toString())) throw "UNAME_TAKEN";
        else if (/unique_slug/.test(err.toString())) throw "UNAME_TAKEN";
        else if (/unique_email/.test(err.toString())) throw "EMAIL_TAKEN";
      }
      throw err;
    }

    try {
      await client.query(
        `
        INSERT INTO unames (user_id, uname, slug)
        VALUES ($1, $2, $3)
      `,
        [user.id, user.uname, user.slug],
      );
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "23505") {
        if (/unique_unrecyclable_slug/.test(err.toString()))
          throw "UNAME_TAKEN";
      }
      throw err;
    }

    const session = await createSession(client, {
      userId: user.id,
      ipAddress: props.ipAddress,
      interval: "1 year", // TODO: Decide how long to log user in upon registration
    });

    await pool.query(`
      INSERT INTO alts
      VALUES ($1, $1)`,
      [user.id]
    );
    //Register user alt
    return { user, session };
  });
}

////////////////////////////////////////////////////////////

export const logoutSession = async function (userId, sessionId) {
  assert(_.isNumber(userId));
  assert(_.isString(sessionId) && belt.isValidUuid(sessionId));

  return pool.query(
    `
    DELETE FROM sessions
    WHERE user_id = $1
      AND id = $2
  `,
    [userId, sessionId],
  );
};

////////////////////////////////////////////////////////////

export const findForums = async function (categoryIds) {
  debug(`[findForums] categoryIds=%j`, categoryIds);
  assert(_.isArray(categoryIds));

  return pool
    .query(
      `
    SELECT
      f.*,
      to_json(p.*) "latest_post",
      to_json(t.*) "latest_topic",
      to_json(u.*) "latest_user"
    FROM forums f
    LEFT OUTER JOIN posts p ON f.latest_post_id = p.id
    LEFT OUTER JOIN topics t ON t.id = p.topic_id
    LEFT OUTER JOIN users u ON u.id = p.user_id
    WHERE f.category_id = ANY ($1::int[])
    ORDER BY pos;
  `,
      [categoryIds],
    )
    .then((res) => res.rows);
  //--WHERE f.category_id IN (${categoryIds}::int[])
};

////////////////////////////////////////////////////////////

// Stats

// https://wiki.postgresql.org/wiki/Count_estimate
export const getApproxCount = async function (tableName) {
  assert(_.isString(tableName));
  return pool
    .query(
      `
    SELECT reltuples "count"
    FROM pg_class
    WHERE relname = $1
  `,
      [tableName],
    )
    .then(maybeOneRow)
    .then((row) => {
      return row.count;
    });
};

////////////////////////////////////////////////////////////

// Ignore nuked users
export const getLatestUser = async function () {
  return pool
    .query(
      `
    SELECT *
    FROM users
    WHERE is_nuked = false
    ORDER BY created_at DESC
    LIMIT 1
  `,
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Users online within the last X minutes
export const getOnlineUsers = async function () {
  return pool
    .query(
      `
    SELECT *
    FROM users
    WHERE last_online_at > NOW() - interval '15 minutes'
    ORDER BY uname
  `,
    )
    .then((res) => res.rows);
};

export async function getMaxTopicId(): Promise<number> {
  return pool
    .query<{ max_id: number }>(`SELECT MAX(id) "max_id" FROM topics`)
    .then(exactlyOneRow)
    .then((res) => res.max_id);
}

export async function getMaxPostId(): Promise<number> {
  return pool
    .query<{ max_id: number }>(`SELECT MAX(id) "max_id" FROM posts`)
    .then(exactlyOneRow)
    .then((res) => res.max_id);
}

export async function getMaxUserId(): Promise<number> {
  return pool
    .query<{ max_id: number }>(`SELECT MAX(id) "max_id" FROM users`)
    .then(exactlyOneRow)
    .then((res) => res.max_id);
}

// https://web.archive.org/web/20131218103719/http://roleplayerguild.com/
const legacyCounts = {
  topics: 210879,
  posts: 9243457,
  users: 44799,
};

export async function getStats() {
  let [topicsCount, usersCount, postsCount, latestUser, onlineUsers] =
    await Promise.all([
      getMaxTopicId(), //getApproxCount('topics'),
      getMaxUserId(), //getApproxCount('users'),
      getMaxPostId(), //getApproxCount('posts'),
      getLatestUser(),
      getOnlineUsers(),
    ]);

  topicsCount += legacyCounts.topics;
  usersCount += legacyCounts.users;
  postsCount += legacyCounts.posts;

  return { topicsCount, usersCount, postsCount, latestUser, onlineUsers };
}

export async function deleteLegacySig(userId: number) {
  return pool.query(
    `
    UPDATE users SET legacy_sig = NULL WHERE id = $1
  `,
    [userId],
  );
}

export async function findStaffUsers() {
  return pool
    .query(
      `
    SELECT u.*
    FROM users u
    WHERE u.role IN ('mod', 'smod', 'admin', 'conmod', 'arenamod', 'pwmod')
  `,
    )
    .then((res) => res.rows);
}

// sub notes have a meta that looks like {ic: true, ooc: true, char: true}
// which indicates which postType the notification has accumulated new
// posts for.
export async function createSubNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    fromUserId: number;
    toUserId: number;
    topicId: number;
    postType: "ic" | "ooc" | "char";
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return;

  // Validate all inputs
  notifications.forEach(({ fromUserId, toUserId, topicId, postType }) => {
    assert(["ic", "ooc", "char"].includes(postType));
    assert(Number.isInteger(topicId));
    assert(Number.isInteger(fromUserId));
    assert(Number.isInteger(toUserId));
  });

  const fromUserIds = notifications.map((n) => n.fromUserId);
  const toUserIds = notifications.map((n) => n.toUserId);
  const topicIds = notifications.map((n) => n.topicId);
  const metas = notifications.map((n) => ({ [n.postType]: true }));

  // Ensure all the unnest arrays have the same length
  assert(fromUserIds.length === toUserIds.length);
  assert(fromUserIds.length === topicIds.length);
  assert(fromUserIds.length === metas.length);

  return pgClient
    .query<DbNotification>(
      `
    INSERT INTO notifications (type, from_user_id, to_user_id, topic_id, meta, count)
    SELECT 
      'TOPIC_SUB',
      unnest($1::int[]),
      unnest($2::int[]), 
      unnest($3::int[]),
      unnest($4::jsonb[]),
      1
    ON CONFLICT (to_user_id, topic_id) WHERE type = 'TOPIC_SUB'
      DO UPDATE
      SET count = COALESCE(notifications.count, 0) + 1,
          meta = notifications.meta || EXCLUDED.meta,
          updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
      [fromUserIds, toUserIds, topicIds, metas],
    )
    .then((res) => res.rows);
}

// Users receive this when someone starts a convo with them
export async function createConvoNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    from_user_id: number;
    to_user_id: number;
    convo_id: number;
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return [];

  // Validate all inputs
  notifications.forEach(({ from_user_id, to_user_id, convo_id }) => {
    assert(Number.isInteger(from_user_id));
    assert(Number.isInteger(to_user_id));
    assert(Number.isInteger(convo_id));
  });

  const fromUserIds = notifications.map((n) => n.from_user_id);
  const toUserIds = notifications.map((n) => n.to_user_id);
  const convoIds = notifications.map((n) => n.convo_id);

  // Ensure all the unnest arrays have the same length
  assert(fromUserIds.length === toUserIds.length);
  assert(fromUserIds.length === convoIds.length);

  return pgClient
    .query<DbNotification>(
      `
      INSERT INTO notifications (type, from_user_id, to_user_id, convo_id, count)
      SELECT 
        'CONVO',
        unnest($1::int[]),
        unnest($2::int[]), 
        unnest($3::int[]),
        1
      ON CONFLICT (to_user_id, convo_id) WHERE type = 'CONVO'
        DO NOTHING
      RETURNING *
      `,
      [fromUserIds, toUserIds, convoIds],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

// Tries to create a convo notification.
// If to_user_id already has a convo notification for this convo, then
// increment the count
export async function createPmNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    from_user_id: number;
    to_user_id: number;
    convo_id: number;
  }>,
) {
  debug(
    "[createPmNotificationsBulk] notifications count: ",
    notifications.length,
  );
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return [];

  // Validate all inputs
  notifications.forEach(({ from_user_id, to_user_id, convo_id }) => {
    assert(_.isNumber(from_user_id));
    assert(_.isNumber(to_user_id));
    assert(convo_id);
  });

  const fromUserIds = notifications.map((n) => n.from_user_id);
  const toUserIds = notifications.map((n) => n.to_user_id);
  const convoIds = notifications.map((n) => n.convo_id);

  // Ensure all the unnest arrays have the same length
  assert(fromUserIds.length === toUserIds.length);
  assert(fromUserIds.length === convoIds.length);

  return pgClient
    .query<DbNotification>(
      `
      INSERT INTO notifications (type, from_user_id, to_user_id, convo_id, count)
      SELECT 
        'CONVO',
        unnest($1::int[]),
        unnest($2::int[]), 
        unnest($3::int[]),
        1
      ON CONFLICT (to_user_id, convo_id) WHERE type = 'CONVO'
        DO UPDATE
        SET count = COALESCE(notifications.count, 0) + 1,
            from_user_id = EXCLUDED.from_user_id,  -- Update to latest sender
            updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [fromUserIds, toUserIds, convoIds],
    )
    .then((result) => result.rows);
}

export async function createTopLevelVmNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    from_user_id: number;
    to_user_id: number;
    vm_id: number;
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return [];

  // Validate all inputs
  notifications.forEach(({ from_user_id, to_user_id, vm_id }) => {
    assert(Number.isInteger(from_user_id));
    assert(Number.isInteger(to_user_id));
    assert(Number.isInteger(vm_id));
  });

  const fromUserIds = notifications.map((n) => n.from_user_id);
  const toUserIds = notifications.map((n) => n.to_user_id);
  const vmIds = notifications.map((n) => n.vm_id);

  // Ensure all the unnest arrays have the same length
  assert(fromUserIds.length === toUserIds.length);
  assert(fromUserIds.length === vmIds.length);

  return pgClient
    .query<DbNotification>(
      `
      INSERT INTO notifications (type, from_user_id, to_user_id, vm_id, count)
      SELECT 
        'TOPLEVEL_VM',
        unnest($1::int[]),
        unnest($2::int[]), 
        unnest($3::int[]),
        1
      ON CONFLICT (to_user_id, vm_id) WHERE type = 'TOPLEVEL_VM'
        DO UPDATE
        SET count = COALESCE(notifications.count, 0) + 1,
            from_user_id = EXCLUDED.from_user_id,  -- Update to latest sender
            updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [fromUserIds, toUserIds, vmIds],
    )
    .then((result) => result.rows);
}

export async function createReplyVmNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    from_user_id: number;
    to_user_id: number;
    vm_id: number;
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return [];

  // Validate all inputs
  notifications.forEach(({ from_user_id, to_user_id, vm_id }) => {
    assert(Number.isInteger(from_user_id));
    assert(Number.isInteger(to_user_id));
    assert(Number.isInteger(vm_id));
  });

  const fromUserIds = notifications.map((n) => n.from_user_id);
  const toUserIds = notifications.map((n) => n.to_user_id);
  const vmIds = notifications.map((n) => n.vm_id);

  // Ensure all the unnest arrays have the same length
  assert(fromUserIds.length === toUserIds.length);
  assert(fromUserIds.length === vmIds.length);

  return pgClient
    .query<DbNotification>(
      `
      INSERT INTO notifications (type, from_user_id, to_user_id, vm_id, count)
      SELECT 
        'REPLY_VM',
        unnest($1::int[]),
        unnest($2::int[]), 
        unnest($3::int[]),
        1
      ON CONFLICT (to_user_id, vm_id) WHERE type = 'REPLY_VM'
        DO UPDATE
        SET count = COALESCE(notifications.count, 0) + 1,
            from_user_id = EXCLUDED.from_user_id,  -- Update to latest sender
            updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [fromUserIds, toUserIds, vmIds],
    )
    .then((result) => result.rows);
}

// Pass in optional notification type to filter
export async function findNotificationsForUserId(
  toUserId: number,
  type?: string,
) {
  assert(Number.isInteger(toUserId));

  const query = `
        SELECT *
        FROM notifications
        WHERE to_user_id = $1
        ${type ? "AND type = $2" : ""}
    `;

  const params = type ? [toUserId, type] : [toUserId];

  return pool.query(query, params).then((res) => res.rows);
}

// Returns how many rows deleted
export async function deleteConvoNotification(
  toUserId: number,
  convoId: number,
): Promise<number> {
  return pool
    .query(
      `
    DELETE FROM notifications
    WHERE type = 'CONVO'
      AND to_user_id = $1
      AND convo_id = $2
  `,
      [toUserId, convoId],
    )
    .then((result) => result.rowCount ?? 0);
}

// Returns how many rows deleted
export async function deleteSubNotifications(
  toUserId: number,
  topicIds: number[],
): Promise<number> {
  assert(Number.isInteger(toUserId));
  assert(Array.isArray(topicIds));
  return pool
    .query(
      `
    DELETE FROM notifications
    WHERE type = 'TOPIC_SUB'
      AND to_user_id = $1
      AND topic_id = ANY ($2)
  `,
      [toUserId, topicIds],
    )
    .then((result) => result.rowCount ?? 0);
}

// Deletes all rows in notifications table for user,
// and also resets the counter caches
export async function clearNotifications(
  toUserId: number,
  notificationIds: number[],
) {
  assert(Number.isInteger(toUserId));
  assert(Array.isArray(notificationIds));

  await pool.query(
    `
    DELETE FROM notifications
    WHERE
      to_user_id = $1
      AND id = ANY ($2::int[])
  `,
    [toUserId, notificationIds],
  );

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  return pool.query(
    `
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
    WHERE users.id = $2
      AND sub.to_user_id = $3
  `,
    [toUserId, toUserId, toUserId],
  );
}

export async function clearConvoNotifications(toUserId: number) {
  await pool.query(
    `
    DELETE FROM notifications
    WHERE to_user_id = $1 AND type = 'CONVO'
  `,
    [toUserId],
  );

  // TODO: Remove
  // Resetting notification count manually until I can ensure
  // notification system doesn't create negative notification counts

  return pool.query(
    `
    UPDATE users
    SET convo_notifications_count = 0
    WHERE id = $1
  `,
    [toUserId],
  );
}

////////////////////////////////////////////////////////////

// Returns [String]
// Stored in cache3.uname-set
//
// A user is active enough to be in this list if:
// - has at least one post/PM or joined in the last month
// - isn't nuked
// - has logged on in the last year
export async function findAllActiveUnames() {
  // pms_count starts at 1 due to welcome message
  return pool
    .query<{ uname: string }>(
      `
    SELECT uname
    FROM users
    WHERE (
        posts_count > 0
        OR pms_count > 1
        OR created_at > NOW() - '1 month'::interval
      )
      AND is_nuked = false
      AND last_online_at > NOW() - '1 year'::interval
  `,
    )
    .then((res) => res.rows.map((row) => row.uname));
}

////////////////////////////////////////////////////////////

export async function findRGNTopicForHomepage(topic_id: number) {
  assert(topic_id);

  return pool
    .query(
      `
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
  `,
      [topic_id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// Keep in sync with findTopicWithHasSubscribed
export async function findTopicById(topicId: number) {
  debug(`[findTopicById] topicId=${topicId}`);
  assert(topicId);

  return pool
    .query<DbTopic>(
      `
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
  ) tags
FROM topics t
JOIN forums f ON t.forum_id = f.id
WHERE t.id = $1
GROUP BY t.id, f.id
  `,
      [topicId],
    )
    .then(maybeOneRow);
}

// props:
// - title Maybe String
// - join-status Maybe (jump-in | apply | full)
//
export async function updateTopic(
  topicId: number,
  props: {
    title?: string;
    join_status?: "jump-in" | "apply" | "full";
  },
) {
  assert(topicId);
  assert(props);

  return pool
    .query(
      `
    UPDATE topics
    SET
      title = COALESCE($1, title),
      join_status = COALESCE($2, join_status)::join_status
    WHERE id = $3
    RETURNING *
  `,
      [props.title, props.join_status, topicId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function createMentionNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    from_user_id: number;
    to_user_id: number;
    post_id: number;
    topic_id: number;
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return [];

  // Validate all inputs
  notifications.forEach(({ from_user_id, to_user_id, post_id, topic_id }) => {
    assert(from_user_id);
    assert(to_user_id);
    assert(post_id);
    assert(topic_id);
  });

  const fromUserIds = notifications.map((n) => n.from_user_id);
  const toUserIds = notifications.map((n) => n.to_user_id);
  const topicIds = notifications.map((n) => n.topic_id);
  const postIds = notifications.map((n) => n.post_id);

  // Ensure all the unnest arrays have the same length
  assert(fromUserIds.length === toUserIds.length);
  assert(fromUserIds.length === topicIds.length);
  assert(fromUserIds.length === postIds.length);

  return pgClient
    .query<{ id: number }>(
      `
    INSERT INTO notifications (type, from_user_id, to_user_id, topic_id, post_id)
    SELECT 
      'MENTION',
      unnest($1::int[]),
      unnest($2::int[]), 
      unnest($3::int[]),
      unnest($4::int[])
    ON CONFLICT (to_user_id, post_id) WHERE type = 'MENTION'
      DO NOTHING
    RETURNING *
    `,
      [fromUserIds, toUserIds, topicIds, postIds],
    )
    .then((result) => result.rows);
}

////////////////////////////////////////////////////////////

export async function parseAndCreateMentionNotifications(
  pgClient: PgClientInTransaction,
  props,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  debug("[parseAndCreateMentionNotifications] Started...");
  assert(props.fromUser.id);
  assert(props.fromUser.uname);
  assert(props.markup);
  assert(props.post_id);
  assert(props.topic_id);

  // Array of lowercase unames that don't include fromUser
  let mentionedUnames = belt.extractMentions(
    props.markup,
    props.fromUser.uname,
  );
  mentionedUnames = _.take(mentionedUnames, config.MENTIONS_PER_POST);

  // Ensure these are users
  const mentionedUsers = await findUsersByUnames(mentionedUnames);

  // Create the notifications in parallel
  const tasks = mentionedUsers.map((toUser) => ({
    from_user_id: props.fromUser.id,
    to_user_id: toUser.id,
    post_id: props.post_id,
    topic_id: props.topic_id,
  }));

  return createMentionNotificationsBulk(pgClient, tasks);
}

////////////////////////////////////////////////////////////

export async function createQuoteNotificationsBulk(
  pgClient: PgClientInTransaction,
  notifications: Array<{
    from_user_id: number;
    to_user_id: number;
    topic_id: number;
    post_id: number;
  }>,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  if (notifications.length === 0) return [];

  // Validate all inputs
  notifications.forEach(({ from_user_id, to_user_id, post_id, topic_id }) => {
    assert(from_user_id);
    assert(to_user_id);
    assert(post_id);
    assert(topic_id);
  });

  // Extract arrays for UNNEST
  const fromUserIds = notifications.map((n) => n.from_user_id);
  const toUserIds = notifications.map((n) => n.to_user_id);
  const topicIds = notifications.map((n) => n.topic_id);
  const postIds = notifications.map((n) => n.post_id);

  // Ensure all the unnest arrays have the same length
  assert(fromUserIds.length === toUserIds.length);
  assert(fromUserIds.length === topicIds.length);
  assert(fromUserIds.length === postIds.length);

  return pgClient
    .query<{ id: number }>(
      `
    INSERT INTO notifications (type, from_user_id, to_user_id, topic_id, post_id)
    SELECT 
      'QUOTE',
      unnest($1::int[]),
      unnest($2::int[]), 
      unnest($3::int[]),
      unnest($4::int[])
    ON CONFLICT (to_user_id, post_id) WHERE type = 'QUOTE'
      DO NOTHING
    RETURNING *
    `,
      [fromUserIds, toUserIds, topicIds, postIds],
    )
    .then((result) => result.rows);
}

// Keep in sync with db.parseAndCreateMentionNotifications
export async function parseAndCreateQuoteNotifications(
  pgClient: PgClientInTransaction,
  props,
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  debug("[parseAndCreateQuoteNotifications] Started...");
  assert(props.fromUser.id);
  assert(props.fromUser.uname);
  assert(props.markup);
  assert(props.post_id);
  assert(props.topic_id);

  // Array of lowercase unames that don't include fromUser
  let mentionedUnames = belt.extractQuoteMentions(
    props.markup,
    props.fromUser.uname,
  );

  mentionedUnames = _.take(mentionedUnames, config.QUOTES_PER_POST);

  // Ensure these are users
  const mentionedUsers = await findUsersByUnames(mentionedUnames);

  // Create the notifications in parallel
  const tasks = mentionedUsers.map((toUser) => ({
    from_user_id: props.fromUser.id,
    to_user_id: toUser.id,
    post_id: props.post_id,
    topic_id: props.topic_id,
  }));

  return createQuoteNotificationsBulk(pgClient, tasks);
}

export const findReceivedNotificationsForUserId = async function (toUserId) {
  return pool
    .query(
      `
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
LIMIT 50
  `,
      [toUserId],
    )
    .then((res) => res.rows);
};

// Returns how many rows deleted
export const deleteNotificationsForPostId = async function (
  toUserId: number,
  postId: number,
): Promise<number> {
  debug(
    `[deleteNotificationsForPostId] toUserId=${toUserId}, postId=${postId}`,
  );
  assert(Number.isInteger(toUserId));
  assert(postId);

  return pool
    .query(
      `
    DELETE FROM notifications
    WHERE to_user_id = $1
      AND post_id = $2
  `,
      [toUserId, postId],
    )
    .then((result) => result.rowCount ?? 0);
};

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
export async function upsertViewer(
  ctx: Context,
  forumId: number,
  topicId?: number,
) {
  assert(forumId);

  if (
    !ctx.currUser ||
    ctx.currUser.is_ghost ||
    ctx.currUser.role === "banned"
  ) {
    // banned and ghosts have their unames hidden
    return pool.query(
      `
      INSERT INTO viewers (ip, forum_id, topic_id, viewed_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (ip) DO UPDATE
        SET forum_id = $4
          , topic_id = $5
          , viewed_at = NOW()
    `,
      [ctx.ip, forumId, topicId, forumId, topicId],
    );
  } else {
    return pool.query(
      `
      INSERT INTO viewers (uname, forum_id, topic_id, viewed_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (uname) DO UPDATE
        SET forum_id = $4
          , topic_id = $5
          , viewed_at = NOW()
    `,
      [ctx.currUser.uname, forumId, topicId, forumId, topicId],
    );
  }
}

// Returns map of ForumId->Int
export async function getForumViewerCounts(): Promise<Record<number, number>> {
  // Query returns { forum_id: Int, viewers_count: Int } for every forum
  const rows = await pool
    .query<{ forum_id: number; viewers_count: number }>(
      `
SELECT
  f.id "forum_id",
  COUNT(v.*) "viewers_count"
FROM forums f
LEFT OUTER JOIN active_viewers v ON f.id = v.forum_id
GROUP BY f.id
  `,
    )
    .then((res) => res.rows);

  const output: Record<number, number> = {};

  rows.forEach((row) => {
    output[row.forum_id] = row.viewers_count;
  });

  return output;
}

// Deletes viewers where viewed_at is older than 15 min ago
// Run this in a cronjob
// Returns Int of viewers deleted
export async function clearExpiredViewers() {
  debug("[clearExpiredViewers] Running");

  const count = await pool
    .query(
      `
    DELETE FROM viewers
    WHERE viewed_at < NOW() - interval '15 minutes'
  `,
    )
    .then((result) => result.rowCount);

  debug("[clearExpiredViewers] Deleted views: " + count);

  return count;
}

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
//
// @fast
export async function findViewersForTopicId(topicId: number) {
  assert(topicId);

  const viewers = await pool
    .query(
      `
    SELECT *
    FROM active_viewers
    WHERE topic_id = $1
    ORDER BY uname
  `,
      [topicId],
    )
    .then((res) => res.rows);

  return {
    users: _.filter(viewers, "uname"),
    guests: _.filter(viewers, "ip"),
  };
}

// Returns viewers as a map of { users: [Viewer], guests: [Viewer] }
//
// @fast
export async function findViewersForForumId(forumId: number) {
  assert(forumId);

  const viewers = await pool
    .query(
      `
    SELECT *
    FROM active_viewers
    WHERE forum_id = $1
    ORDER BY uname
  `,
      [forumId],
    )
    .then((res) => res.rows);

  return {
    users: viewers.filter((x) => x.uname),
    guests: viewers.filter((x) => x.ip),
  };
}

// leaveRedirect: Bool
export async function moveTopic(
  topicId,
  fromForumId,
  toForumId,
  leaveRedirect,
) {
  assert(_.isNumber(toForumId));

  let topic;

  if (leaveRedirect) {
    topic = await pool
      .query(
        `
      UPDATE topics
      SET forum_id = $1,
          moved_from_forum_id = $2,
          moved_at = NOW()
      WHERE id = $3
      RETURNING *
    `,
        [toForumId, fromForumId, topicId],
      )
      .then(maybeOneRow);
  } else {
    topic = await pool
      .query(
        `
      UPDATE topics
      SET forum_id = $1, moved_at = NOW()
      WHERE id = $2
      RETURNING *
    `,
        [toForumId, topicId],
      )
      .then(maybeOneRow);
  }

  // TODO: Put this in transaction

  // FIXME: parallel queries aren't a thing
  const [fromForum, toForum] = await Promise.all([
    pool
      .query(`SELECT * FROM forums WHERE id = $1`, [fromForumId])
      .then(maybeOneRow),
    pool
      .query(`SELECT * FROM forums WHERE id = $1`, [toForumId])
      .then(maybeOneRow),
  ]);

  // If moved topic's latest post is newer than destination forum's latest post,
  // then update destination forum's latest post.
  if (topic.latest_post_id > toForum.latest_post_id) {
    debug("[moveTopic] Updating toForum latest_post_id");
    debug(
      "topic.id: %s, topic.latest_post_id: %s",
      topic.id,
      topic.latest_post_id,
    );

    await pool.query(
      `
      UPDATE forums
      SET latest_post_id = $1
      WHERE id = $2
    `,
      [topic.latest_post_id, topic.forum_id],
    );
  }

  // Update fromForum.latest_post_id if it was topic.latest_post_id since
  // we moved the topic out of this forum.
  if (topic.latest_post_id === fromForum.latest_post_id) {
    debug("[moveTopic] Updating fromForum.latest_post_id");
    await pool.query(
      `
      UPDATE forums
      SET latest_post_id = (
        SELECT MAX(t.latest_post_id) "latest_post_id"
        FROM topics t
        WHERE t.forum_id = $1
      )
      WHERE id = $2
    `,
      [fromForumId, fromForumId],
    );
  }

  return topic;
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
export async function ratePost(props: {
  post_id: number;
  from_user_id: number;
  from_user_uname: string;
  to_user_id: number;
  type: DbRatingType;
}) {
  assert(props.post_id);
  assert(props.from_user_id);
  assert(props.from_user_uname);
  assert(props.to_user_id);
  assert(props.type);

  return pool
    .query(
      `
    INSERT INTO ratings (from_user_id, from_user_uname, post_id, type, to_user_id)
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5
    )
    ON CONFLICT (from_user_id, post_id) DO NOTHING
    RETURNING *
  `,
      [
        props.from_user_id,
        props.from_user_uname,
        props.post_id,
        props.type,
        props.to_user_id,
      ],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function findLatestRatingForUserId(userId: number) {
  assert(userId);

  return pool
    .query(
      `
    SELECT *
    FROM ratings
    WHERE from_user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `,
      [userId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function findRatingByFromUserIdAndPostId(from_user_id, post_id) {
  assert(from_user_id);
  assert(post_id);

  return pool
    .query(
      `
    SELECT *
    FROM ratings
    WHERE from_user_id = $1
      AND post_id = $2
  `,
      [from_user_id, post_id],
    )
    .then(maybeOneRow);
}

export async function deleteRatingByFromUserIdAndPostId(
  pgClient: PgClientInTransaction,
  from_user_id: number,
  post_id: number,
) {
  assert(from_user_id);
  assert(post_id);

  return pgClient.query(
    `
    DELETE FROM ratings
    WHERE from_user_id = $1 AND post_id = $2
    RETURNING *
  `,
    [from_user_id, post_id],
  );
}

export async function deleteLegacyAvatar(userId: number) {
  return pool
    .query(
      `
    UPDATE users
    SET legacy_avatar_url = null
    WHERE id = $1
    RETURNING *
  `,
      [userId],
    )
    .then(maybeOneRow);
}

export async function deleteAvatar(userId: number) {
  return pool
    .query(
      `
UPDATE users
SET legacy_avatar_url = null, avatar_url = ''
WHERE id = $1
RETURNING *
  `,
      [userId],
    )
    .then(maybeOneRow);
}

// User receives this when someone rates their post
// Required props:
// - from_user_id
// - to_user_id
// - post_id
// - topic_id
// - rating_type: Any rating_type enum
// Returns created notification
//
// TODO: Handle rating undo
export async function createRatingNotification(props: {
  from_user_id: number;
  to_user_id: number;
  post_id: number;
  topic_id: number;
  rating_type: "like" | "laugh" | "thank";
}) {
  assert(props.from_user_id);
  assert(props.to_user_id);
  assert(props.post_id);
  assert(props.topic_id);
  assert(props.rating_type);

  // TODO: does that {type: _} thing work?

  return pool
    .query<DbNotification>(
      `
INSERT INTO notifications
(type, from_user_id, to_user_id, meta, post_id, topic_id)
VALUES ('RATING', $1, $2, $3, $4, $5)
ON CONFLICT (from_user_id, post_id) WHERE type = 'RATING' DO UPDATE
    SET updated_at = NOW(),
        meta = $3
RETURNING *
  `,
      [
        props.from_user_id, // $1
        props.to_user_id, // $2
        { type: props.rating_type }, // $3
        props.post_id, // $4
        props.topic_id, // $5
      ],
    )
    .then(exactlyOneRow);
}

export async function updateTopicCoGms(topicId: number, userIds: number[]) {
  assert(topicId);
  assert(_.isArray(userIds));

  return pool
    .query<DbTopic>(
      `
    UPDATE topics
    SET co_gm_ids = $1
    WHERE id = $2
    RETURNING *
  `,
      [userIds, topicId],
    )
    .then(exactlyOneRow);
}

export async function findAllTags() {
  return pool.query<DbTag>(`SELECT * FROM tags`).then((res) => res.rows);
}

// Returns [TagGroup] where each group has [Tag] array bound to `tags` property
export async function findAllTagGroups(): Promise<unknown[]> {
  return pool
    .query(
      `
    SELECT
      *,
      (SELECT json_agg(t.*) FROM tags t WHERE t.tag_group_id = tg.id) tags
    FROM tag_groups tg
  `,
    )
    .then((res) => res.rows);
}

// topicId :: String | Int
// tagIds :: [Int]
export const updateTopicTags = async function (topicId, tagIds) {
  assert(topicId);
  assert(_.isArray(tagIds));

  return pool.withTransaction(async (client) => {
    await client.query(
      `
      DELETE FROM tags_topics
      WHERE topic_id = $1
    `,
      [topicId],
    );
    // Now create the new bridge links in parallel
    // FIXME: Can't make parallel requests on a single connection, so
    // make it explicitly serial.
    return Promise.all(
      tagIds.map((tagId) => {
        return client.query(
          `
        INSERT INTO tags_topics (topic_id, tag_id)
        VALUES ($1, $2)
      `,
          [topicId, tagId],
        );
      }),
    );
  });
};

// Returns latest 5 unhidden checks
export async function findLatestChecks() {
  const forumIds = [12, 38, 13, 14, 15, 16, 40, 43];

  return pool
    .query(
      `
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
  `,
      [forumIds],
    )
    .then((res) => res.rows);
}

// Returns latest 5 unhidden roleplays
export async function findLatestRoleplays() {
  const forumIds = [3, 4, 5, 6, 7, 39, 42];
  return pool
    .query(
      `
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
  `,
      [forumIds],
    )
    .then((res) => res.rows);
}

export const findAllPublicTopicUrls = async function () {
  return pool
    .query(
      `
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
  `,
    )
    .then((res) => res.rows)
    .then((rows) => {
      return rows.map((row) => pre.presentTopic(row).url);
    });
};

export const findPostsByIds = async function (ids) {
  assert(_.isArray(ids));
  ids = ids.map(Number); // Ensure ids are numbers, not strings

  const rows = await pool
    .query(
      `
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
  `,
      [ids],
    )
    .then((res) => res.rows);

  // Reorder posts by the order of ids passed in
  const out: any[] = [];

  ids.forEach((id) => {
    const row = rows.find((row) => row.id === id);
    if (row) out.push(row);
  });

  return out;
};

////////////////////////////////////////////////////////////

export async function getUnamesMappedToIds() {
  const rows = await pool
    .query(
      `
    SELECT uname, id FROM users
  `,
    )
    .then((res) => res.rows);

  const out = {};

  rows.forEach((row) => {
    out[row.uname.toLowerCase()] = row.id;
  });

  return out;
}

////////////////////////////////////////////////////////////

// Trophies are returned newly-awarded first
export async function findTrophiesForUserId(user_id: number) {
  return pool
    .query(
      `
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
  `,
      [user_id],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

// Finds one trophy
export async function findTrophyById(trophy_id: number) {
  return pool
    .query(
      `
    SELECT
      t.*,
      to_json(tg.*) "group"
    FROM trophies t
    LEFT OUTER JOIN trophy_groups tg ON t.group_id = tg.id
    WHERE t.id = $1
    GROUP BY t.id, tg.id
  `,
      [trophy_id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export const findTrophiesByGroupId = async function (group_id) {
  return pool
    .query(
      `
    SELECT *
    FROM trophies t
    WHERE t.group_id = $1
    ORDER BY t.id ASC
  `,
      [group_id],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export async function findTrophyGroups() {
  return pool
    .query(
      `
    SELECT *
    FROM trophy_groups
    ORDER BY id DESC
  `,
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

export async function findTrophyGroupById(group_id: number) {
  return pool
    .query(
      `
    SELECT *
    FROM trophy_groups tg
    WHERE tg.id = $1
  `,
      [group_id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// title Required
// description_markup Optional
// description_html Optional
export async function updateTrophyGroup(
  id: number,
  title: string,
  desc_markup: string,
  desc_html: string,
) {
  return pool
    .query(
      `
    UPDATE trophy_groups
    SET
      title = $1,
      description_markup = $2,
      description_html = $3
    WHERE id = $4
    RETURNING *
  `,
      [title, desc_markup, desc_html, id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// Update individual trophy
//
// title Required
// description_markup Optional
// description_html Optional
export async function updateTrophy(
  id: number,
  title: string,
  desc_markup: string,
  desc_html: string,
) {
  assert(Number.isInteger(id));

  return pool
    .query(
      `
UPDATE trophies
SET
  title = $1,
  description_markup = $2,
  description_html = $3
WHERE id = $4
RETURNING *
  `,
      [title, desc_markup, desc_html, id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// Update trophy<->user bridge record
//
// message_markup Optional
// message_html Optional
export async function updateTrophyUserBridge(
  id: number,
  message_markup: string,
  message_html: string,
) {
  assert(Number.isInteger(id));

  return pool
    .query(
      `
    UPDATE trophies_users
    SET
      message_markup = $1,
      message_html = $2
    WHERE id = $3
    RETURNING *
  `,
      [message_markup, message_html, id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export const deactivateCurrentTrophyForUserId = async function (user_id) {
  assert(_.isNumber(user_id));

  return pool
    .query(
      `
    UPDATE users
    SET active_trophy_id = NULL
    WHERE id = $1
  `,
      [user_id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const updateUserActiveTrophyId = async function (user_id, trophy_id) {
  assert(_.isNumber(user_id));
  assert(_.isNumber(trophy_id));

  return pool
    .query(
      `
    UPDATE users
    SET active_trophy_id = $1
    WHERE id = $2
  `,
      [trophy_id, user_id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findTrophyUserBridgeById = async function (id) {
  debug("[findTrophyUserBridgeById] id=%j", id);
  assert(id);

  return pool
    .query(
      `
    SELECT
      tu.*,
      to_json(t.*) AS trophy,
      to_json(u.*) AS user
    FROM trophies_users tu
    JOIN trophies t ON tu.trophy_id = t.id
    JOIN users u ON tu.user_id = u.id
    WHERE tu.id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Deprecated now that I've added a primary key serial to trophies_users.
//
// Instead, use db.findTrophyUserBridgeById(id)
export const findTrophyByIdAndUserId = async function (trophy_id, user_id) {
  assert(_.isNumber(user_id));
  assert(_.isNumber(trophy_id));

  return pool
    .query(
      `
    SELECT trophies.*
    FROM trophies_users
    JOIN trophies ON trophies_users.trophy_id = trophies.id
    WHERE trophies_users.trophy_id = $1
      AND trophies_users.user_id = $2
    LIMIT 1
  `,
      [trophy_id, user_id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findWinnersForTrophyId = async function (trophy_id) {
  return pool
    .query(
      `
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
  `,
      [trophy_id],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

// description_markup and _html are optional
//
// Returns created trophy group
export const createTrophyGroup = async function (
  title,
  description_markup,
  description_html,
) {
  assert(_.isString(title));
  assert(_.isUndefined(description_markup) || _.isString(description_markup));
  assert(_.isUndefined(description_html) || _.isString(description_html));

  return pool
    .query(
      `
INSERT INTO trophy_groups (title, description_markup, description_html)
VALUES ($1, $2, $3)
RETURNING *
  `,
      [title, description_markup, description_html],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// props must have user_id (Int), text (String), html (String) properties
export const createStatus = async function ({ user_id, html, text }) {
  assert(Number.isInteger(user_id));
  assert(typeof text === "string");
  assert(typeof html === "string");

  return pool
    .query(
      `
    INSERT INTO statuses (user_id, text, html)
    VALUES ($1, $2, $3)
    RETURNING *
  `,
      [user_id, text, html],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// @fast
export async function findLatestStatusesForUserId(user_id: number) {
  return pool
    .query(
      `
    SELECT *
    FROM statuses
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 5
  `,
      [user_id],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

export const findStatusById = async function (id) {
  return pool
    .query(
      `
    SELECT
      us.*,
      to_json(u.*) "user"
    FROM statuses us
    JOIN users u ON us.user_id = u.id
    WHERE us.id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const deleteStatusById = async function (id) {
  return pool.query(
    `
    DELETE FROM statuses
    WHERE id = $1
  `,
    [id],
  );
};

////////////////////////////////////////////////////////////

export async function findLatestStatuses() {
  return pool
    .query(
      `
    SELECT
      us.*,
      to_json(u.*) "user"
    FROM statuses us
    JOIN users u ON us.user_id = u.id
    WHERE u.is_nuked = false
    ORDER BY created_at DESC
    LIMIT 8
  `,
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

export const clearCurrentStatusForUserId = async function (user_id) {
  assert(user_id);

  return pool.query(
    `
UPDATE users
SET current_status_id = NULL
WHERE id = $1
  `,
    [user_id],
  );
};

////////////////////////////////////////////////////////////

export const findAllStatuses = async function () {
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
  const statuses = await pool
    .query(
      `
WITH sids AS (
  SELECT s.id
  FROM statuses s
  JOIN users u ON s.user_id = u.id
  WHERE u.is_nuked = false
  ORDER BY s.created_at DESC
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
  `,
    )
    .then((res) => res.rows);

  statuses.forEach((status) => {
    status.likers = (status.likers || []).filter(Boolean);
  });

  return statuses;
};

export const likeStatus = async function ({ user_id, status_id }) {
  assert(Number.isInteger(user_id));
  assert(Number.isInteger(status_id));

  return pool
    .withTransaction(async (client) => {
      // 1. Create status_likes row

      await client.query(
        `
      INSERT INTO status_likes (status_id, user_id)
      VALUES ($1, $2)
    `,
        [status_id, user_id],
      );

      // 2. Update status

      return client.query(
        `
      UPDATE statuses
      SET liked_user_ids = array_append(liked_user_ids, $1)
      WHERE id = $2
    `,
        [user_id, status_id],
      );
    })
    .catch((err) => {
      if (err.code === "23505") {
        return;
      }
      throw err;
    });
};

////////////////////////////////////////////////////////////

// Returns created_at Date OR null for user_id
export const latestStatusLikeAt = async function (user_id) {
  assert(user_id);

  const row = await pool
    .query(
      `
    SELECT MAX(created_at) created_at
    FROM status_likes
    WHERE user_id = $1
  `,
      [user_id],
    )
    .then(maybeOneRow);

  return row && row.created_at;
};

////////////////////////////////////////////////////////////

export const updateTopicWatermark = async function (props) {
  debug("[updateTopicWatermark] props:", props);
  assert(props.topic_id);
  assert(props.user_id);
  assert(props.post_type);
  assert(props.post_id);

  return pool.query(
    `
    INSERT INTO topics_users_watermark
      (topic_id, user_id, post_type, watermark_post_id)
    VALUES (
      $1, $2, $3, $4
    )
    ON CONFLICT (topic_id, user_id, post_type) DO UPDATE
      SET watermark_post_id = GREATEST(topics_users_watermark.watermark_post_id, $5)
  `,
    [
      props.topic_id,
      props.user_id,
      props.post_type,
      props.post_id,
      props.post_id,
    ],
  );
};

////////////////////////////////////////////////////////////

// FIXME: This was redeclared further down.
export const _findFirstUnreadPostId = async function ({
  topic_id,
  post_type,
  user_id,
}) {
  assert(topic_id);
  assert(post_type);

  const row = await pool
    .query(
      `
    SELECT COALESCE(
      MIN(p.id),
      (
        SELECT MIN(p2.id)
        FROM posts p2
        WHERE p2.topic_id = $1
          AND p2.type = $2
          AND p2.is_hidden = false
      )
    ) post_id
    FROM posts p
    WHERE
      p.id > (
        SELECT w.watermark_post_id
        FROM topics_users_watermark w
        WHERE w.topic_id = $3
          AND w.user_id = $4
          AND w.post_type = $5
      )
      AND p.topic_id = $6
      AND p.type = $7
      AND p.is_hidden = false
  `,
      [topic_id, post_type, topic_id, user_id, post_type, topic_id, post_type],
    )
    .then(maybeOneRow);

  return row && row.post_id;
};

////////////////////////////////////////////////////////////

export const findFirstUnreadPostId = async function ({
  topic_id,
  post_type,
  user_id,
}) {
  debug(
    `[findFirstUnreadPostId] topic_id=%j, post_type=%j, user_id=%j`,
    topic_id,
    post_type,
    user_id,
  );
  assert(user_id);
  assert(topic_id);
  assert(post_type);

  const row = await pool
    .query(
      `
SELECT COALESCE(MIN(p.id),
  CASE $1::post_type
    WHEN 'ic' THEN
      (SELECT t.latest_ic_post_id FROM topics t WHERE t.id = $2)
    WHEN 'ooc' THEN
      (SELECT COALESCE(t.latest_ooc_post_id, t.latest_post_id) FROM topics t WHERE t.id = $3)
    WHEN 'char' THEN
      (SELECT t.latest_char_post_id FROM topics t WHERE t.id = $4)
  END
) post_id
FROM posts p
WHERE
  p.id > COALESCE(
    (
      SELECT w.watermark_post_id
      FROM topics_users_watermark w
      WHERE w.topic_id = $5
        AND w.user_id = $6
        AND w.post_type = $7
    ),
    0
  )
  AND p.topic_id = $8
  AND p.type = $9
  `,
      [
        post_type,
        topic_id,
        topic_id,
        topic_id,
        topic_id,
        user_id,
        post_type,
        topic_id,
        post_type,
      ],
    )
    .then(maybeOneRow);

  return row && row.post_id;
};

export const deleteNotificationForUserIdAndId = async function (userId, id) {
  debug(`[deleteNotificationsForUserIdAndId] userId=${userId}, id=${id}`);

  assert(Number.isInteger(userId));
  assert(Number.isInteger(id));

  return pool.query(
    `
    DELETE FROM notifications
    WHERE to_user_id = $1
      AND id = $2
  `,
    [userId, id],
  );
};

export const findNotificationById = async function (id) {
  debug(`[findNotification] id=${id}`);
  return pool
    .query(
      `
    SELECT *
    FROM notifications
    WHERE id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Returns the current feedback topic only if:
// - User has not already replied to it (or clicked ignore)
export const findUnackedFeedbackTopic = function (feedback_topic_id, user_id) {
  assert(_.isNumber(feedback_topic_id));
  assert(_.isNumber(user_id));

  return pool
    .query(
      `
    SELECT *
    FROM feedback_topics
    WHERE
      id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM feedback_replies fr
        WHERE fr.feedback_topic_id = $2
          AND fr.user_id = $3
      )
  `,
      [feedback_topic_id, feedback_topic_id, user_id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findFeedbackTopicById = async function (ftopic_id) {
  assert(_.isNumber(ftopic_id));

  return pool
    .query(
      `
    SELECT feedback_topics.*
    FROM feedback_topics
    WHERE id = $1
  `,
      [ftopic_id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const findFeedbackRepliesByTopicId = async function (ftopic_id) {
  assert(_.isNumber(ftopic_id));

  return pool
    .query(
      `
    SELECT
      fr.*,
      u.uname
    FROM feedback_replies fr
    JOIN users u ON fr.user_id = u.id
    WHERE fr.feedback_topic_id = $1
    ORDER BY id DESC
  `,
      [ftopic_id],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

export const insertReplyToUnackedFeedbackTopic = async function (
  feedback_topic_id,
  user_id,
  text,
  ignored,
) {
  assert(_.isNumber(feedback_topic_id));
  assert(_.isNumber(user_id));
  assert(_.isBoolean(ignored));

  return pool
    .query(
      `
    INSERT INTO feedback_replies (user_id, ignored, text, feedback_topic_id)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `,
      [user_id, ignored, text, feedback_topic_id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

// Defaults to the most active 10 friends
export const findFriendshipsForUserId = async function (user_id, limit = 100) {
  assert(_.isNumber(user_id));

  return pool
    .query(
      `
SELECT
  friendships.*,
  json_build_object(
    'uname', u1.uname,
    'last_online_at', u1.last_online_at,
    'avatar_url', u1.avatar_url,
    'slug', u1.slug,
    'is_ghost', u1.is_ghost
  ) "to_user",
  EXISTS(
    SELECT 1
    FROM friendships
    WHERE to_user_id = $1
      AND from_user_id = u1.id
  ) "is_mutual"
FROM friendships
JOIN users u1 ON friendships.to_user_id = u1.id
WHERE from_user_id = $2
ORDER BY u1.last_online_at DESC NULLS LAST
LIMIT $3
  `,
      [user_id, user_id, limit],
    )
    .then((res) => res.rows);
};

// @fast
//
// TODO: add is_mutual
export const findFriendshipBetween = async function (from_id, to_id) {
  return pool
    .query(
      `
    SELECT *
    FROM friendships
    WHERE from_user_id = $1 AND to_user_id = $2
  `,
      [from_id, to_id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export async function createFriendship(from_id: number, to_id: number) {
  assert(_.isNumber(from_id));
  assert(_.isNumber(to_id));

  // Note: race condition
  const count = await pool
    .query<{ count: number }>(
      `
    SELECT COUNT(*) "count"
    FROM friendships
    WHERE from_user_id = $1
  `,
      [from_id],
    )
    .then(maybeOneRow)
    .then((row) => row!.count);

  if (count >= 100) {
    throw "TOO_MANY_FRIENDS";
  }

  return pool
    .query(
      `
    INSERT INTO friendships (from_user_id, to_user_id)
    VALUES ($1, $2)
  `,
      [from_id, to_id],
    )
    .catch((err) => {
      // Ignore unique violation, like if user double-clicks
      // the add-friend button
      if (err.code === "23505") {
        return;
      }
      throw err;
    });
}

export const deleteFriendship = async function (from_id, to_id) {
  assert(_.isNumber(from_id));
  assert(_.isNumber(to_id));

  return pool.query(
    `
    DELETE FROM friendships
    WHERE from_user_id = $1 AND to_user_id = $2
  `,
    [from_id, to_id],
  );
};

////////////////////////////////////////////////////////////

// Returns array of all unique user IDs that have posted a VM
// in a thread, given the root VM ID of that thread
export async function getVmThreadUserIds(
  pgClient: PgQueryExecutor,
  parentVmId: number,
) {
  assert(Number.isInteger(parentVmId));

  return pgClient
    .query<Pick<DbVm, "from_user_id">>(
      `
    SELECT DISTINCT from_user_id
    FROM vms
    WHERE id = $1
       OR parent_vm_id = $2
  `,
      [parentVmId, parentVmId],
    )
    .then((res) => res.rows.map((vm) => vm.from_user_id));
}

// data:
// - to_user_id: Int
// - from_user_id: Int
// - markup
// - html
// Optional
// - parent_vm_id: Int - Only present if this VM is a reply to a toplevel VM
export async function createVm(
  pgClient: PgClientInTransaction,
  data: {
    from_user_id: number;
    to_user_id: number;
    markup: string;
    html: string;
    parent_vm_id: number | null;
  },
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(Number.isInteger(data.from_user_id));
  assert(Number.isInteger(data.to_user_id));
  assert(_.isString(data.markup));
  assert(_.isString(data.html));

  return pgClient
    .query<DbVm>(
      `
INSERT INTO vms (from_user_id, to_user_id, markup, html, parent_vm_id)
VALUES ($1, $2, $3, $4, $5)
RETURNING *
  `,
      [
        data.from_user_id,
        data.to_user_id,
        data.markup,
        data.html,
        data.parent_vm_id,
      ],
    )
    .then(exactlyOneRow);
}

export const findLatestVMsForUserId = async function (user_id) {
  assert(Number.isInteger(user_id));

  // Created index for this: create index vms_apple ON vms (to_user_id, parent_vm_id)
  return pool
    .query(
      `
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
WHERE vms.to_user_id = $1 AND parent_vm_id IS NULL
ORDER BY vms.id DESC
LIMIT 30
  `,
      [user_id],
    )
    .then((res) => res.rows);
};

export const clearVmNotification = async function (to_user_id, vm_id) {
  assert(Number.isInteger(to_user_id));
  assert(Number.isInteger(vm_id));

  return pool.query(
    `
    DELETE FROM notifications
    WHERE to_user_id = $1 AND vm_id = $2
  `,
    [to_user_id, vm_id],
  );
};

////////////////////////////////////////////////////////////
// current_sidebar_contests

export const clearCurrentSidebarContest = async function () {
  return pool.query(`
    UPDATE current_sidebar_contests
    SET is_current = false
  `);
};

export const updateCurrentSidebarContest = async function (id, data) {
  assert(Number.isInteger(id));
  assert(_.isString(data.title) || _.isUndefined(data.title));
  assert(_.isString(data.topic_url) || _.isUndefined(data.topic_url));
  assert(_.isString(data.deadline) || _.isUndefined(data.deadline));
  assert(_.isString(data.image_url) || _.isUndefined(data.image_url));
  assert(_.isString(data.description) || _.isUndefined(data.description));
  assert(_.isBoolean(data.is_current) || _.isUndefined(data.is_current));

  // Reminder: Only COALESCE things that are not nullable
  return pool
    .query(
      `
    UPDATE current_sidebar_contests
    SET
      title       = COALESCE($1, title),
      topic_url   = COALESCE($2, topic_url),
      deadline    = COALESCE($3, deadline),
      image_url   = $4,
      description = $5,
      is_current  = COALESCE($6, is_current)
    WHERE id = $7
    RETURNING *
  `,
      [
        data.title,
        data.topic_url,
        data.deadline,
        data.image_url,
        data.description,
        data.is_current,
        id,
      ],
    )
    .then(maybeOneRow);
};

export const insertCurrentSidebarContest = async function (data) {
  assert(_.isString(data.title));
  assert(_.isString(data.topic_url));
  assert(_.isString(data.deadline));
  assert(_.isString(data.image_url) || _.isUndefined(data.image_url));
  assert(_.isString(data.description) || _.isUndefined(data.description));

  return pool
    .query(
      `
    INSERT INTO current_sidebar_contests
    (title, topic_url, deadline, image_url, description, is_current)
    VALUES
    ($1, $2, $3, $4, $5, true)
    RETURNING *
  `,
      [
        data.title,
        data.topic_url,
        data.deadline,
        data.image_url,
        data.description,
      ],
    )
    .then(maybeOneRow);
};

// Returns object or undefined
export async function getCurrentSidebarContest() {
  return pool
    .query(
      `
    SELECT *
    FROM current_sidebar_contests
    WHERE is_current = true
    ORDER BY id DESC
    LIMIT 1
  `,
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export const updateConvoFolder = async function (userId, convoId, folder) {
  assert(Number.isInteger(userId));
  assert(convoId);
  assert(_.isString(folder));

  return pool.query(
    `
    UPDATE convos_participants
    SET folder = $1
    WHERE user_id = $2
      AND convo_id = $3
  `,
    [folder, userId, convoId],
  );
};

////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////
// NUKING
////////////////////////////////////////////////////////////

// Remember to also approve an unnuked user. Didn't do it
// here because i don't currently pass in unnuker_id
export const unnukeUser = async function (userId) {
  assert(Number.isInteger(userId));
  const sqls = {
    unbanUser: {
      text: `UPDATE users SET role = 'member', is_nuked = false WHERE id = $1`,
      values: [userId],
    },
    unhideTopics: {
      text: `UPDATE topics SET is_hidden = false WHERE user_id = $1`,
      values: [userId],
    },
    unhidePosts: {
      text: `UPDATE posts SET is_hidden = false WHERE user_id = $1`,
      values: [userId],
    },
    deleteFromNukelist: {
      text: `DELETE FROM nuked_users WHERE user_id = $1`,
      values: [userId],
    },
  };
  return pool.withTransaction(async (client) => {
    await client.query(sqls.unbanUser);
    await client.query(sqls.unhideTopics);
    await client.query(sqls.unhidePosts);
    await client.query(sqls.deleteFromNukelist);
  });
};

// In one fell motion, bans a user, hides all their stuff.
//
// Takes an object to prevent mistakes.
// { spambot: UserId, nuker: UserId  }
export const nukeUser = async function ({ spambot, nuker }) {
  assert(Number.isInteger(spambot));
  assert(Number.isInteger(nuker));

  const sqls = {
    banUser: {
      text: `UPDATE users SET role = 'banned', is_nuked = true WHERE id = $1`,
      values: [spambot],
    },
    hideTopics: {
      text: `UPDATE topics SET is_hidden = true WHERE user_id = $1`,
      values: [spambot],
    },
    hidePosts: {
      text: `UPDATE posts SET is_hidden = true WHERE user_id = $1`,
      values: [spambot],
    },
    insertNukelist: {
      text: `INSERT INTO nuked_users (user_id, nuker_id) VALUES ($1, $2)`,
      values: [spambot, nuker],
    },
    // Update the latest_post_id of every topic
    // that the nuked user has a latest post in
    //
    // TODO: Undo this in `unnukeUser`.
    //
    // FIXME: This is too slow.
    updateTopics: {
      text: `
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
          WHERE p.user_id = $1
        ) sub on posts.topic_id = sub.topic_id
        WHERE posts.is_hidden = false
        GROUP BY sub.topic_id
      ) sub2
      WHERE id = sub2.topic_id
    `,
      values: [spambot],
    },
  };

  return pool
    .withTransaction(async (client) => {
      await client.query(sqls.banUser);
      await client.query(sqls.hideTopics);
      await client.query(sqls.hidePosts);
      await client.query(sqls.insertNukelist);
      //await client.query(sqls.updateTopics)
    })
    .catch((err) => {
      if (err.code === "23505") {
        throw "ALREADY_NUKED";
      }
      throw err;
    });
};

////////////////////////////////////////////////////////////

// Delete topic ban for given topic+user combo
export const deleteUserTopicBan = async (topicId, userId) => {
  assert(Number.isInteger(topicId));
  assert(Number.isInteger(userId));

  return pool.query(
    `
    DELETE FROM topic_bans
    WHERE topic_id = $1
      AND banned_id = $2
  `,
    [topicId, userId],
  );
};

export const deleteTopicBan = async (banId) => {
  assert(Number.isInteger(banId));

  return pool.query(
    `
    DELETE FROM topic_bans
    WHERE id = $1
  `,
    [banId],
  );
};

export const getTopicBan = async (banId) => {
  assert(Number.isInteger(banId));

  return pool
    .query(
      `
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
    WHERE tb.id = $1
  `,
      [banId],
    )
    .then(maybeOneRow);
};

export const insertTopicBan = async (topicId, gmId, bannedId) => {
  assert(Number.isInteger(topicId));
  assert(Number.isInteger(gmId));
  assert(Number.isInteger(bannedId));

  return pool
    .query(
      `
    INSERT INTO topic_bans (topic_id, banned_by_id, banned_id)
    VALUES ($1, $2, $3)
  `,
      [topicId, gmId, bannedId],
    )
    .catch((err) => {
      if (err.code === "23505") {
        return;
      }
      throw err;
    });
};

export const listTopicBans = async (topicId) => {
  assert(Number.isInteger(topicId));

  return pool
    .query(
      `
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
    WHERE tb.topic_id = $1
  `,
      [topicId],
    )
    .then((res) => res.rows);
};

export async function allForumMods(): Promise<
  Array<{
    forum_id: number;
    user: {
      id: number;
      uname: string;
      slug: string;
    };
  }>
> {
  return pool
    .query(
      `
    SELECT
      fm.forum_id,
      json_build_object(
        'id', u.id,
        'uname', u.uname,
        'slug', u.slug
      ) "user"
    FROM users u
    JOIN forum_mods fm ON u.id = fm.user_id
  `,
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

// Re-exports

export * as keyvals from "./keyvals";
export * as ratelimits from "./ratelimits";
export * as images from "./images";
export * as dice from "./dice";
export * as profileViews from "./profile-views";
// Function aliases
export const findUser = findUserById;
export const getUserBySlug = findUserBySlug;
export const findPost = findPostById;
export const findPm = findPmById;
export const findForum = findForumById;

// Sub-modules
export * as users from "./users";
export * as chat from "./chat";
export * as subscriptions from "./subscriptions";
export * as vms from "./vms";
export * as convos from "./convos";
export * as tags from "./tags";
export * as revs from "./revs";
export * as unames from "./unames";
export * as hits from "./hits";
export * as admin from "./admin";
export * as notifications from "./notifications";
