// 3rd party
import _ from "lodash";
import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db");
import Knex from "knex";
const knex = Knex({ client: "pg" });
import pgArray from "postgres-array";
import { v7 as uuidv7 } from "uuid";
// 1st party
import * as config from "../config";
import * as belt from "../belt";
import { hashPassword } from "../auth";
import * as pre from "../presenters";
import { can, MOD_CATEGORY_ID, type Role } from "../cancan";
import { fetchReadable } from "../readable";
import type { SignupPermit } from "../signup_gate";
import { trustedSql } from "../trust";
import {
  pool,
  maybeOneRow,
  exactlyOneRow,
  PgClientInTransaction,
} from "./util";
import { Client, Pool, PoolClient } from "pg";
import { BANNED_IDS_JSON, forumModsColumn } from "./readable";
import { deleteEmailVerificationTokenByUserId } from "./email_verification";
import { lockSender, spend } from "./send_budget";
import { VmParentRefused } from "./vms";
import { AlreadyNuked, TooManyFriends } from "./refusals";
import { takenBy, violatedUniqueIndex } from "./unique_violations";
import { Context } from "koa";
import {
  DbConvo,
  DbNotification,
  DbPm,
  DbRating,
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

export type ResetToken = {
  user_id: number;
  token: string;
  created_at: Date;
  expired_at: Date;
};

// Issues a password reset token, or returns null while the account's last
// token is still active. The check and the insert share one transaction behind
// lockSender, so requests at once cannot each find no active token. POST
// /forgot mails only a token this returns
// (server/routes/password-reset.ts#sendResetMail), so one token lifetime sends
// one mail.
export async function issueResetToken(
  userId: number,
): Promise<ResetToken | null> {
  assert(Number.isInteger(userId));

  return pool.withTransaction(async (client) => {
    await lockSender(client, userId);

    // clock_timestamp, not now(): now() is when the transaction began, which
    // is stale after a wait on the lock. The token is stamped with this value.
    const { now, last_expired_at } = await client
      .query<{ now: Date; last_expired_at: Date | null }>(
        `
        SELECT
          clock_timestamp() AS now,
          (SELECT max(expired_at) FROM reset_tokens WHERE user_id = $1)
            AS last_expired_at
      `,
        [userId],
      )
      .then(exactlyOneRow);

    // Active through its expired_at, as the active_reset_tokens view counts it
    if (last_expired_at && last_expired_at >= now) return null;

    return client
      .query<ResetToken>(
        `
        INSERT INTO reset_tokens (user_id, token, created_at, expired_at)
        VALUES ($1, $2, $3, $3::timestamptz + INTERVAL '15 minutes')
        RETURNING *
      `,
        [userId, uuidv7(), now],
      )
      .then(exactlyOneRow);
  });
}

////////////////////////////////////////////////////////////

export const findUserById = async function (id: number) {
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

  return pool
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
}

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
export const findUserByUnameOrEmail = async function (unameOrEmail: string) {
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
export const findUserByEmail = async function (email: string) {
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
export const findUserByUname = async function (uname: string) {
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

// A page of a user's posts, newest first, that `viewer` may read
//
// `beforeId` is undefined or a number
export async function findRecentPostsForUserId(
  viewer: any,
  userId: number,
  beforeId: number | undefined,
) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));

  const base = knex("posts as p")
    .select(
      "p.*",
      knex.raw('to_json(t.*) "topic"'),
      knex.raw('to_json(f.*) "forum"'),
    )
    .join("topics as t", "p.topic_id", "t.id")
    .join("forums as f", "t.forum_id", "f.id")
    .where("p.user_id", userId)
    .where("p.id", "<", beforeId || 1e9)
    .orderBy("p.id", "desc")
    .limit(config.RECENT_POSTS_PER_PAGE);

  return fetchReadable(viewer, "READ_POST", base, {
    posts: "p",
    topics: "t",
    forums: "f",
  });
}

////////////////////////////////////////////////////////////

// A page of the topics a user started, newest first, that `viewer` may read.
// Each topic's first_post is its opening post, or null when the viewer may
// not read that post.
//
// `beforeId` is undefined or a number
export async function findRecentTopicsForUserId(
  viewer: any,
  userId: number,
  beforeId: number | undefined,
) {
  assert(_.isNumber(beforeId) || _.isUndefined(beforeId));

  const topics = await fetchReadable(
    viewer,
    "READ_TOPIC",
    knex("topics as t")
      .select(
        "t.*",
        knex.raw('to_json(f.*) "forum"'),
        // READ_TOPIC reads them
        knex.raw(forumModsColumn("t.forum_id")),
      )
      .join("forums as f", "t.forum_id", "f.id")
      .where("t.user_id", userId)
      .where("t.id", "<", beforeId || 1e9)
      .orderBy("t.id", "desc")
      .limit(config.RECENT_POSTS_PER_PAGE),
    { topics: "t", forums: "f" },
  );

  if (topics.length === 0) return topics;

  // The opening post has its topic's lowest post id:
  // server/db/forum_text_writes.ts#createTopic inserts it
  // with the topic, and a GM's 0th post (idx -1) comes later. The scope then
  // drops it if the viewer may not read it; no other post stands in for it.
  const openingPosts = await fetchReadable(
    viewer,
    "READ_POST",
    knex("posts as p")
      .select(
        "p.*",
        knex.raw('to_json(t.*) "topic"'),
        knex.raw('to_json(f.*) "forum"'),
      )
      .join("topics as t", "p.topic_id", "t.id")
      .join("forums as f", "t.forum_id", "f.id")
      .whereIn(
        "p.id",
        knex("posts")
          .min("id")
          .whereIn(
            "topic_id",
            topics.map((topic) => topic.id),
          )
          .groupBy("topic_id"),
      ),
    { posts: "p", topics: "t", forums: "f" },
  );

  const openingPostByTopicId = _.keyBy(openingPosts, "topic_id");
  for (const topic of topics) {
    topic.first_post = openingPostByTopicId[topic.id] ?? null;
  }
  return topics;
}

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

// Who a convo is from. A member pays the send budget. Staff is the sender of
// the registration welcome PM and pays nothing. It carries no id, so passing
// it for a member would send as the staff account, where everyone sees it.
export type ConvoSender =
  | { kind: "member"; userId: number }
  | { kind: "staff" };

// If toUserIds is empty, then it's a self-convo
export async function createConvo(
  pgClient: PgClientInTransaction,
  args: {
    sender: ConvoSender;
    toUserIds: number[];
    title: string;
    markup: string;
    html: string;
    ipAddress: string;
  },
) {
  debug("[createConvo] args: ", args);
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(Array.isArray(args.toUserIds));
  assert(typeof args.title === "string");
  assert(typeof args.markup === "string");
  assert(typeof args.html === "string");

  // config parses an unset STAFF_REPRESENTATIVE_ID to NaN.
  const userId =
    args.sender.kind === "member"
      ? args.sender.userId
      : config.STAFF_REPRESENTATIVE_ID;
  assert(Number.isInteger(userId), `Invalid convo sender: ${userId}`);

  const participantIds = [...new Set([userId, ...args.toUserIds])];

  if (args.sender.kind === "member") {
    // One per member it reaches, which pays for the opening PM below too. A
    // self-convo reaches no one and still costs 1.
    await spend(pgClient, userId, Math.max(1, participantIds.length - 1));
  }

  // Create convo
  const convo = await pgClient
    .query<DbConvo>(
      `
      INSERT INTO convos (user_id, title)
      VALUES ($1, $2)
      RETURNING *
    `,
      [userId, args.title],
    )
    .then(exactlyOneRow);

  // Bulk-insert all participants
  await pgClient.query(
    `
    INSERT INTO convos_participants (convo_id, user_id)
    SELECT $1, unnest($2::int[])
  `,
    [convo.id, participantIds],
  );

  // insert the PM
  const pm = await pgClient
    .query(
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
      [convo.id, userId, args.ipAddress, args.markup, args.html],
    )
    .then(exactlyOneRow);

  // Assoc firstPm to the returned convo
  (convo as any).firstPm = pm;
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

// One page of a forum's topics that `viewer` may read, stickies first. For a
// logged-in viewer each topic also says whether they have posted in it
// (has_posted) and whether it has posts past their watermark (unread_posts).
export async function findTopicsByForumId(
  viewer: any,
  forumId: number,
  limit: number,
  offset: number,
) {
  debug(
    "[findTopicsByForumId] forumId: %s, limit: %s, offset: %s",
    forumId,
    limit,
    offset,
  );

  const base = knex("topics as t")
    .select(
      "t.*",
      knex.raw('to_json(u.*) "user"'),
      knex.raw('to_json(p.*) "latest_post"'),
      knex.raw('to_json(u2.*) "latest_user"'),
      knex.raw('to_json(f.*) "forum"'),
      // READ_TOPIC reads them
      knex.raw(forumModsColumn("t.forum_id")),
      knex.raw(`(
        SELECT json_agg(tags.*)
        FROM tags
        JOIN tags_topics ON tags.id = tags_topics.tag_id
        WHERE tags_topics.topic_id = t.id
      ) tags`),
    )
    .join("users as u", "t.user_id", "u.id")
    .leftJoin("posts as p", "t.latest_post_id", "p.id")
    .leftJoin("users as u2", "p.user_id", "u2.id")
    .leftJoin("forums as f", "t.forum_id", "f.id")
    .where("t.forum_id", forumId)
    .orderBy("t.is_sticky", "desc")
    .orderBy("t.latest_post_at", "desc")
    .limit(limit)
    .offset(offset);

  // Guests skip these subqueries
  if (viewer) {
    base.select(
      knex.raw(
        `EXISTS(
          SELECT 1 FROM posts WHERE topic_id = t.id AND user_id = ?
        ) has_posted`,
        [viewer.id],
      ),
      knex.raw(
        `(
          SELECT t.latest_post_id > (
            SELECT COALESCE(MAX(w.watermark_post_id), 0)
            FROM topics_users_watermark w
            WHERE w.topic_id = t.id
              AND w.user_id = ?
          )
        ) unread_posts`,
        [viewer.id],
      ),
    );
  }

  return fetchReadable(viewer, "READ_TOPIC", base, {
    topics: "t",
    forums: "f",
  });
}

////////////////////////////////////////////////////////////

// Replace a user's password and log them in. Must run inside a transaction.
//
// Every password change after signup belongs here. A new password must end
// every grant that let a holder of the old one act as the account or take it
// over, so each is deleted before the caller's new session is inserted, and
// that session is the only one left. The caller hashes first, so bcrypt never
// holds a pooled client.
export async function replacePasswordTx(
  pgClient: PgClientInTransaction,
  userId: number,
  digest: string,
  session: { ipAddress: string; interval: string },
): Promise<DbSession> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(Number.isInteger(userId));
  assert(typeof digest === "string");

  await pgClient.query(
    `
    UPDATE users
    SET digest = $1
    WHERE id = $2
  `,
    [digest, userId],
  );

  await pgClient.query(
    `
    DELETE FROM sessions
    WHERE user_id = $1
  `,
    [userId],
  );

  await pgClient.query(
    `
    DELETE FROM reset_tokens
    WHERE user_id = $1
  `,
    [userId],
  );

  await deleteEmailVerificationTokenByUserId(pgClient, userId);

  return createSession(pgClient, { userId, ...session });
}

////////////////////////////////////////////////////////////

// Keep server/db/forum_text_writes.ts#updatePost and updatePm in sync
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

// The only loader of a post by id. Attaches the topic, with its ban list, and
// the forum, which the post actions in server/cancan.ts read.
export const findPostById = async function (postId: number) {
  return pool
    .query(
      `
SELECT
  p.*,
  (to_jsonb(t.*) || jsonb_build_object('banned_ids', ${BANNED_IDS_JSON})) "topic",
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

export const findPmById = async function findPm(id: number) {
  return pool
    .query(
      `
SELECT
  pms.*,
  to_json(c.*) "convo"
FROM pms
JOIN convos c ON pms.convo_id = c.id
JOIN users pu ON pms.user_id = pu.id
JOIN users cu ON c.user_id = cu.id
WHERE pms.id = $1
  AND pu.is_nuked = false
  AND cu.is_nuked = false
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
  AND u.is_nuked = false
GROUP BY pms.id, u.id
ORDER BY pms.id
  `,
      [convoId, fromIdx, toIdx],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

// `topic` is the page's topic, as db.loadTopicFor returns it. Each post gets
// it as post.topic, and its forum as post.forum, so the post actions in
// server/cancan.ts read the page's topic, ban list included, with no per-row
// copy of the topic from SQL.
export const findPostsByTopicId = async function (topic, postType, page) {
  debug(
    "[findPostsByTopicId] topicId: %s, postType: %s, page",
    topic.id,
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

      CASE
        WHEN s.id IS NOT NULL THEN
          json_build_object(
            'html', s.html,
            'created_at', s.created_at
          )
      END "current_status",

      to_json(array_remove(array_agg(r.*), null)) ratings
    FROM posts p
    JOIN users u ON p.user_id = u.id
    LEFT OUTER JOIN ratings r ON p.id = r.post_id
    LEFT OUTER JOIN statuses s
      ON u.current_status_id = s.id AND u.is_nuked = false
    WHERE p.topic_id = $1
      AND p.type = $2
      AND p.idx >= $3
      AND p.idx < $4
    GROUP BY p.id, u.id, s.id
    ORDER BY p.idx
  `,
      [topic.id, postType, fromIdx, toIdx],
    )
    .then((res) => res.rows);

  // One copy for every post, taken before the route sets topic.posts, so no
  // post points back at the list it sits in, which would make presentTopic
  // recurse forever. It leaves out topic.user: presentPost presents post.topic
  // again, and presentUser is not idempotent (see its posts_count hack).
  const { posts: _posts, user: _user, ...postTopic } = topic;

  return rows.map((row) => {
    row.topic = postTopic;
    row.forum = topic.forum;
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
JOIN users pu ON pms.user_id = pu.id
JOIN users cu ON c.user_id = cu.id
JOIN convos_participants cp ON cp.convo_id = pms.convo_id
JOIN users u ON cp.user_id = u.id
WHERE pms.id = $1
  AND pu.is_nuked = false
  AND cu.is_nuked = false
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

  // A flat 1: a reply reaches only members the convo already reached, and it
  // sends no mail.
  await spend(pgClient, props.userId, 1);

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

// Generic user-update route. Intended to be paired with
// the generic PUT /users/:userId route.
// TODO: Use the knex updater instead
// Note: deliberately has no email slot. Confirmation is the sole writer of
// users.email (plan/2026-08-11-1613/I2); a slot here would be a second writer,
// able to change the address while email_verified_at stays set.
// Nor a custom_title slot: updateUserCustomTitle is that column's sole writer,
// so only a route that checked UPDATE_USER_CUSTOM_TITLE reaches it.
export const updateUser = async (userId, attrs) => {
  debug("[updateUser] attrs", attrs);

  return pool
    .query(
      `
    UPDATE users
    SET
      sig = COALESCE($1, sig),
      avatar_url = COALESCE($2, avatar_url),
      hide_sigs = COALESCE($3, hide_sigs),
      is_ghost = COALESCE($4, is_ghost),
      sig_html = COALESCE($5, sig_html),
      is_grayscale = COALESCE($6, is_grayscale),
      force_device_width = COALESCE($7, force_device_width),
      hide_avatars = COALESCE($8, hide_avatars),
      eflags = COALESCE($9, eflags)
    WHERE id = $10
    RETURNING *
  `,
      [
        attrs.sig,
        attrs.avatar_url,
        attrs.hide_sigs,
        attrs.is_ghost,
        attrs.sig_html,
        attrs.is_grayscale,
        attrs.force_device_width,
        attrs.hide_avatars,
        attrs.eflags,
        userId,
      ],
    )
    .then(maybeOneRow);
};

// The sole writer of users.custom_title. Its guard is UPDATE_USER_CUSTOM_TITLE.
export async function updateUserCustomTitle(userId: number, title: string) {
  return pool.query(
    `
    UPDATE users
    SET custom_title = $1
    WHERE id = $2
  `,
    [title, userId],
  );
}

////////////////////////////////////////////////////////////

// The role columns of a staff role write's actor and account, as they stand
// now. Locks both rows until the transaction ends, so neither role can change
// between the rule's check and the write. One statement locks them in id
// order, so two staff acting on each other at once cannot deadlock.
async function lockRoleRows(
  client: PgClientInTransaction,
  actorId: number,
  userId: number,
) {
  assert(Number.isInteger(actorId));
  assert(Number.isInteger(userId));
  const { rows } = await client.query<{
    id: number;
    role: Role;
    is_nuked: boolean;
  }>(
    `
    SELECT id, role, is_nuked
    FROM users
    WHERE id = ANY($1::int[])
    ORDER BY id
    FOR NO KEY UPDATE
  `,
    [[actorId, userId]],
  );
  const user = rows.find((row) => row.id === userId);
  if (!user) throw new Error(`lockRoleRows: no user ${userId}`);
  // A deleted actor asks as a guest, which every role rule refuses
  return { actor: rows.find((row) => row.id === actorId) ?? null, user };
}

// The writer of users.role for staff role changes. It asks UPDATE_USER_ROLE
// about the live, locked rows, not the ones its caller loaded, so a route
// that skipped its own check, or a role that changed after the route read it,
// writes nothing. A refusal here is a 500: the route's own check answers the
// usual case first.
export async function updateUserRole({
  actorId,
  userId,
  role,
}: {
  actorId: number;
  userId: number;
  role: Role;
}) {
  return pool.withTransaction(async (client) => {
    const { actor, user } = await lockRoleRows(client, actorId, userId);
    if (!can(actor, "UPDATE_USER_ROLE", { user, role })) {
      throw new Error(
        `UPDATE_USER_ROLE refused: user ${actorId} may not make user ${userId} ${role}`,
      );
    }
    await client.query(
      `
      UPDATE users
      SET role = $1
      WHERE id = $2
    `,
      [role, userId],
    );
  });
}

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

// What createUserWithSession did. Only CREATED carries the account and its
// session, so a caller cannot read either after a refusal, and an exhaustive
// switch on type makes it answer each refusal.
export type SignupResult =
  | { type: "CREATED"; user: DbUser; session: DbSession }
  | SignupRefusal;

export type SignupRefusal = { type: "UNAME_TAKEN" } | { type: "EMAIL_TAKEN" };

// Thrown inside createUserWithSession's transaction so that it rolls back.
// The refusal is returned only after the rollback: a value returned from the
// transaction would COMMIT, and a later edit could then commit half an
// account.
class SignupRefused extends Error {
  override name = "SignupRefused";
  constructor(readonly refusal: SignupRefusal) {
    super(refusal.type);
  }
}

// A unique violation on a member's name or address refuses the signup.
// Every other error passes through.
function refuseIfTaken(err: unknown): never {
  const taken = takenBy(err);
  if (taken) throw new SignupRefused({ type: taken });
  throw err;
}

// Creates a user and a session (logs them in). A name in the unames history
// stays taken unless an admin let it be recycled.
//
// The permit is proof that the request passed
// server/signup_gate.ts#admitSignup, so no caller can make an account without
// the registration switch and the human test.
export async function createUserWithSession(
  permit: SignupPermit,
  props: {
    uname: string;
    ipAddress: string;
    password: string;
    email: string;
  },
): Promise<SignupResult> {
  debug("[createUserWithSession] props: ", props);
  assert(permit, "createUserWithSession needs a SignupPermit");
  assert(_.isString(props.uname));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.password));
  assert(_.isString(props.email));

  const digest = await hashPassword(props.password);
  const slug = belt.slugifyUname(props.uname);

  try {
    return await pool.withTransaction(async (client) => {
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
        throw new SignupRefused({ type: "UNAME_TAKEN" });
      }

      const user = await client
        .query<DbUser>(
          `
        INSERT INTO users (uname, digest, email, slug, hide_sigs, registration_ip, email_gate_exempt_at)
        VALUES ($1, $2, $3, $4, true, $5, $6)
        RETURNING *
      `,
          [
            props.uname,
            digest,
            props.email,
            slug,
            props.ipAddress,
            // Fail-open when we cannot mail a confirmation link at all: without
            // this, local dev and any misconfigured deploy would wall every new
            // account with no way to unwall it (plan/2026-08-11-1613).
            config.IS_EMAIL_CONFIGURED ? null : new Date(),
          ],
        )
        .then(exactlyOneRow)
        .catch(refuseIfTaken);

      await client
        .query(
          `
        INSERT INTO unames (user_id, uname, slug)
        VALUES ($1, $2, $3)
      `,
          [user.id, user.uname, user.slug],
        )
        .catch(refuseIfTaken);

      const session = await createSession(client, {
        userId: user.id,
        ipAddress: props.ipAddress,
        interval: "1 year", // TODO: Decide how long to log user in upon registration
      });

      return { type: "CREATED", user, session } as const;
    });
  } catch (err) {
    if (err instanceof SignupRefused) return err.refusal;
    throw err;
  }
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

// Sets a roleplay's join status. The title has its own writer, which screens
// it: server/forum_text.ts#retitleTopic.
export async function updateTopicJoinStatus(
  topicId: number,
  joinStatus: "jump-in" | "apply" | "full",
) {
  assert(Number.isInteger(topicId));
  assert(["jump-in", "apply", "full"].includes(joinStatus));

  return pool
    .query(
      `
    UPDATE topics
    SET join_status = $1::join_status
    WHERE id = $2
    RETURNING *
  `,
      [joinStatus, topicId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

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

// The gap a member leaves between ratings, and between status likes, so a
// burst cannot flood other members with notifications.
const RATING_GAP_SECONDS = 3;

// Whether a rating or like at `now`, the database clock, falls inside the gap
// after the member's last one at lastAt.
function isInsideRatingGap(lastAt: Date | null, now: Date): boolean {
  return (
    lastAt !== null &&
    now.getTime() < lastAt.getTime() + RATING_GAP_SECONDS * 1000
  );
}

export type RatePostResult =
  | { type: "RATED"; rating: DbRating }
  // The rater already rated this post
  | { type: "DUPLICATE" }
  | { type: "TOO_SOON" };

// Rates a post, unless the rater rated it before or rated anything inside the
// gap. The gap check and the insert share one transaction behind lockSender,
// so a burst of ratings cannot all pass the gap.
export async function ratePost(props: {
  post_id: number;
  from_user_id: number;
  from_user_uname: string;
  to_user_id: number;
  type: DbRatingType;
}): Promise<RatePostResult> {
  assert(props.post_id);
  assert(Number.isInteger(props.from_user_id));
  assert(props.from_user_uname);
  assert(props.to_user_id);
  assert(props.type);

  return pool.withTransaction(async (client) => {
    await lockSender(client, props.from_user_id);

    // clock_timestamp, not now(): now() is when the transaction began, which
    // is stale after a wait on the lock. The rating is stamped with this value.
    const { now, last_at } = await client
      .query<{ now: Date; last_at: Date | null }>(
        `
        SELECT
          clock_timestamp() AS now,
          (SELECT max(created_at) FROM ratings WHERE from_user_id = $1)
            AS last_at
      `,
        [props.from_user_id],
      )
      .then(exactlyOneRow);
    if (isInsideRatingGap(last_at, now)) return { type: "TOO_SOON" };

    const rating = await client
      .query<DbRating>(
        `
        INSERT INTO ratings
          (from_user_id, from_user_uname, post_id, type, to_user_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (from_user_id, post_id) DO NOTHING
        RETURNING *
      `,
        [
          props.from_user_id,
          props.from_user_uname,
          props.post_id,
          props.type,
          props.to_user_id,
          now,
        ],
      )
      .then(maybeOneRow);
    return rating ? { type: "RATED", rating } : { type: "DUPLICATE" };
  });
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
export async function updateTopicTags(topicId: number, tagIds: number[]) {
  assert(topicId);
  assert(Array.isArray(tagIds));

  return pool.withTransaction(async (pgClient) => {
    // Delete existing tags
    await pgClient.query("DELETE FROM tags_topics WHERE topic_id = $1", [
      topicId,
    ]);

    // Bulk insert using unnest
    if (tagIds.length > 0) {
      await pgClient.query(
        `INSERT INTO tags_topics (topic_id, tag_id) 
         SELECT $1, unnest($2::int[])`,
        [topicId, tagIds],
      );
    }
  });
}

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
        WHERE category_id <> $1
      )
    ORDER BY id
  `,
      [MOD_CATEGORY_ID],
    )
    .then((res) => res.rows)
    .then((rows) => {
      return rows.map((row) => pre.presentTopic(row).url);
    });
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

// Owns the rule that a user can only display a trophy they were awarded, so
// a caller cannot set one by skipping a lookup. Returns false, and changes
// nothing, when the user does not hold the trophy.
export async function updateUserActiveTrophyId(
  userId: number,
  trophyId: number,
): Promise<boolean> {
  assert(Number.isInteger(userId));
  assert(Number.isInteger(trophyId));

  const result = await pool.query(
    `
    UPDATE users
    SET active_trophy_id = $2
    WHERE id = $1
      AND EXISTS (
        SELECT 1
        FROM trophies_users
        WHERE user_id = $1
          AND trophy_id = $2
      )
  `,
    [userId, trophyId],
  );
  return (result.rowCount ?? 0) > 0;
}

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

export async function createStatus(
  pgClient: PgClientInTransaction,
  { user_id, html, text }: { user_id: number; html: string; text: string },
) {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(Number.isInteger(user_id));
  assert(typeof text === "string");
  assert(typeof html === "string");

  await spend(pgClient, user_id, 1);

  return pgClient
    .query(
      `
    INSERT INTO statuses (user_id, text, html)
    VALUES ($1, $2, $3)
    RETURNING *
  `,
      [user_id, text, html],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// @fast
export async function findLatestStatusesForUserId(user_id: number) {
  return pool
    .query(
      `
    SELECT s.*
    FROM statuses s
    JOIN users u ON s.user_id = u.id
    WHERE s.user_id = $1
      AND u.is_nuked = false
    ORDER BY s.created_at DESC
    LIMIT 5
  `,
      [user_id],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

// Loads a status to like or delete it, never to show it, so it keeps a nuked
// author's statuses and staff can still delete one.
export const findStatusById = async function (id: number) {
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

// How many of the newest statuses, by members who are not nuked, the homepage
// panel reads. It bounds the panel's work on each cache3 refresh. A flood of
// more statuses than this pushes older trusted statuses out until staff nuke
// the flood's accounts.
export const STATUS_PANEL_WINDOW = 1000;

// The homepage status panel, which every visitor sees, guests included. It
// shows each trusted member's current status (users.current_status_id), newest
// first. So one account holds at most one slot, and an account holds none
// until server/trust.ts trusts it. A status its author clears or deletes
// leaves, and no older one comes back. /statuses and profiles list every
// status.
//
// The trust rule runs only on the window's rows. Postgres pushes no filter
// into a subquery with a LIMIT. As one plain join, the planner ran the rule
// on every member.
export async function findLatestStatuses() {
  return pool
    .query(
      `
    SELECT
      recent.*,
      to_json(u.*) "user"
    FROM (
      SELECT us.*
      FROM statuses us
      JOIN users author ON author.id = us.user_id
      WHERE author.is_nuked = false
      ORDER BY us.created_at DESC
      LIMIT ${STATUS_PANEL_WINDOW}
    ) recent
    JOIN users u
      ON u.id = recent.user_id
      AND u.current_status_id = recent.id
    WHERE ${trustedSql("u")}
    ORDER BY recent.created_at DESC
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

export type LikeStatusResult =
  | { type: "LIKED" }
  // The member already liked this status
  | { type: "DUPLICATE" }
  | { type: "TOO_SOON" };

// Likes a status, unless the member liked it before or liked anything inside
// the rating gap. The gap check and the insert share one transaction behind
// lockSender, so a burst of likes cannot all pass the gap.
export async function likeStatus({
  user_id,
  status_id,
}: {
  user_id: number;
  status_id: number;
}): Promise<LikeStatusResult> {
  assert(Number.isInteger(user_id));
  assert(Number.isInteger(status_id));

  return pool.withTransaction(async (client) => {
    await lockSender(client, user_id);

    // clock_timestamp, not now(): now() is when the transaction began, which
    // is stale after a wait on the lock. The like is stamped with this value.
    const { now, last_at } = await client
      .query<{ now: Date; last_at: Date | null }>(
        `
        SELECT
          clock_timestamp() AS now,
          (SELECT max(created_at) FROM status_likes WHERE user_id = $1)
            AS last_at
      `,
        [user_id],
      )
      .then(exactlyOneRow);
    if (isInsideRatingGap(last_at, now)) return { type: "TOO_SOON" };

    const inserted = await client.query(
      `
      INSERT INTO status_likes (status_id, user_id, created_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (status_id, user_id) DO NOTHING
    `,
      [status_id, user_id, now],
    );
    if (!inserted.rowCount) return { type: "DUPLICATE" };

    await client.query(
      `
      UPDATE statuses
      SET liked_user_ids = array_append(liked_user_ids, $1)
      WHERE id = $2
    `,
      [user_id, status_id],
    );
    return { type: "LIKED" };
  });
}

////////////////////////////////////////////////////////////

export async function updateTopicWatermark(props: {
  topic_id: number;
  user_id: number;
  post_type: string;
  post_id: number;
}) {
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
}

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

export const findNotificationById = async function (id: number) {
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

// The most friends a member may add
const MAX_FRIENDS = 100;

// Adds a friendship, or throws TooManyFriends when the member already has
// MAX_FRIENDS. The count and the insert share one transaction behind
// lockSender, so a burst of adds cannot all pass the cap.
export async function createFriendship(
  from_id: number,
  to_id: number,
): Promise<void> {
  assert(_.isNumber(from_id));
  assert(_.isNumber(to_id));

  await pool.withTransaction(async (client) => {
    await lockSender(client, from_id);

    const { count } = await client
      .query<{ count: number }>(
        `
        SELECT COUNT(*)::int AS count
        FROM friendships
        WHERE from_user_id = $1
      `,
        [from_id],
      )
      .then(exactlyOneRow);
    if (count >= MAX_FRIENDS) {
      throw new TooManyFriends();
    }

    // A double click on the add-friend button adds nothing more
    await client.query(
      `
      INSERT INTO friendships (from_user_id, to_user_id)
      VALUES ($1, $2)
      ON CONFLICT (from_user_id, to_user_id) DO NOTHING
    `,
      [from_id, to_id],
    );
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

// Posts a VM on to_user_id's wall. parent_vm_id is null for a new thread, or
// names the thread a reply goes under. Throws VmParentRefused for a reply
// whose parent is not a thread on that wall.
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
  assert(data.parent_vm_id === null || Number.isInteger(data.parent_vm_id));
  assert(_.isString(data.markup));
  assert(_.isString(data.html));

  // A reply goes under a thread on its own wall: a top-level VM with the same
  // to_user_id. The wall lists a thread's replies by parent alone, and
  // DELETE_VM lets a wall owner delete only VMs addressed to them, so a reply
  // under another wall's thread would show there out of that owner's reach. A
  // reply under a reply would never show. No code changes a VM's wall or
  // parent, so this check at insert holds the rule. It runs before spend, so
  // a refused reply costs nothing, and it locks no row, so the sender's lock
  // still comes first (server/db/send_budget.ts#lockSender).
  if (data.parent_vm_id !== null) {
    const parent = await pgClient
      .query<Pick<DbVm, "to_user_id" | "parent_vm_id">>(
        `
    SELECT to_user_id, parent_vm_id
    FROM vms
    WHERE id = $1
  `,
        [data.parent_vm_id],
      )
      .then(maybeOneRow);
    if (
      !parent ||
      parent.to_user_id !== data.to_user_id ||
      parent.parent_vm_id !== null
    ) {
      throw new VmParentRefused();
    }
  }

  await spend(pgClient, data.from_user_id, 1);

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
        AND u2.is_nuked = false
    ) sub
  ) child_vms
FROM vms
JOIN users u ON vms.from_user_id = u.id
WHERE vms.to_user_id = $1 AND parent_vm_id IS NULL
  AND u.is_nuked = false
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

// Makes a nuked account a member again and unhides all its stuff. Like
// updateUserRole, it asks UNNUKE_USER about the live, locked rows before it
// writes. The route approves the account afterwards.
export async function unnukeUser({
  actorId,
  userId,
}: {
  actorId: number;
  userId: number;
}) {
  const sqls = {
    unbanUser: {
      text: `UPDATE users SET role = 'member', is_nuked = false WHERE id = $1`,
      values: [userId],
    },
    unhideTopics: {
      text: `UPDATE topics SET is_hidden = false WHERE user_id = $1`,
      values: [userId],
    },
    // Triggers post_hidden on every post that we unhide which updates each topic's latest post
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
    const { actor, user } = await lockRoleRows(client, actorId, userId);
    if (!can(actor, "UNNUKE_USER", user)) {
      throw new Error(
        `UNNUKE_USER refused: user ${actorId} may not unnuke user ${userId}`,
      );
    }
    await client.query(sqls.unbanUser);
    await client.query(sqls.unhideTopics);
    await client.query(sqls.unhidePosts);
    await client.query(sqls.deleteFromNukelist);
  });
}

// In one fell motion, bans a user, hides all their stuff. Throws AlreadyNuked
// when the account was nuked already.
//
// Takes an object to prevent mistakes.
// { spambot: UserId, nuker: UserId  }
export async function nukeUser({
  spambot,
  nuker,
}: {
  spambot: number;
  nuker: number;
}) {
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
    // FIXME: This triggers the post_hidden trigger on EVERY post that we hide.
    // It would be better to delete the trigger and instead call some bulk update db fn
    // every time we hide posts.
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
    //   updateTopics: {
    //     text: `
    //   UPDATE topics t
    //   SET
    //     latest_post_id = latest_posts.id,
    //     latest_post_at = latest_posts.created_at
    //   FROM (
    //     -- Find the new latest post for each affected topic
    //     SELECT DISTINCT ON (affected.topic_id)
    //       affected.topic_id,
    //       p.id,
    //       p.created_at
    //     FROM (
    //       -- Get topics where the nuked user has the latest post
    //       SELECT t.id as topic_id
    //       FROM topics t
    //       JOIN posts p ON t.latest_post_id = p.id
    //       WHERE p.user_id = $1
    //     ) affected
    //     JOIN posts p ON p.topic_id = affected.topic_id
    //     -- Don't exclude the nuked user's posts - they're already hidden
    //     ORDER BY
    //       affected.topic_id,
    //       p.is_hidden ASC,     -- Prefer non-hidden posts
    //       p.created_at DESC    -- Get the most recent
    //   ) latest_posts
    //   WHERE t.id = latest_posts.topic_id
    // `,
    //     values: [spambot],
    //   },
  };

  return pool
    .withTransaction(async (client) => {
      await client.query(sqls.banUser);
      await client.query(sqls.hideTopics);
      await client.query(sqls.hidePosts);
      await client.query(sqls.insertNukelist);
      // await client.query(sqls.updateTopics);
    })
    .catch((err) => {
      // Only the one-nuke-per-account index means a finished nuke. Any other
      // violation is a different failure, and rethrows.
      if (violatedUniqueIndex(err) === "nuked_user_id") {
        throw new AlreadyNuked();
      }
      throw err;
    });
}

////////////////////////////////////////////////////////////

// Delete topic ban for given topic+user combo
export async function deleteUserTopicBan(topicId: number, userId: number) {
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
}

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
      if (err instanceof Error && "code" in err && err.code === "23505") {
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

////////////////////////////////////////////////////////////

// Re-exports

export * as keyvals from "./keyvals";
export * as loginAttempts from "./login_attempts";
export * as images from "./images";
export * as dice from "./dice";
export * as profileViews from "./profile-views";
// The only by-id topic and forum loaders; see server/db/readable.ts
export { loadTopicFor, loadForumFor } from "./readable";
// Function aliases
export const findUser = findUserById;
export const getUserBySlug = findUserBySlug;
export const findPost = findPostById;
export const findPm = findPmById;

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
export * as emailVerification from "./email_verification";
