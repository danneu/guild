// Member standing: the one rule for when a member stops counting as new. A
// trusted member skips the spam check and gets the larger budgets, caps and
// the short post gap. Every reader asks this module: a write reads standing
// once through server/db/send_budget.ts#lockStanding, a query that lists
// members embeds trustedSql, and server/standing_sweep.test.ts fails on server
// code elsewhere that compares posts_count or reads approved_at
// (docs/agents/budgets.md#standing).
//
// The rule reads live rows, not the users.posts_count counter. A member is
// trusted once staff approve them, or once more than TRUSTED_AFTER_POSTS of
// their posts are visible, sit in visible topics, are not a tab's 0th post,
// and are at least config.TRUST_MIN_POST_AGE_SECONDS old. So a bot cannot
// earn trust in a minute: its posts must stay up, where mods see them, for
// the whole floor. A post cannot predate its account, so the floor ages the
// account too. Hiding a post or its topic stops it counting at once. The rule
// is one SQL text, so one member's read and a list query cannot disagree.

import assert from "assert";
import type pg from "pg";
// 1st
import * as config from "./config";
import { exactlyOneRow } from "./db/util";

// A member is trusted once more than this many of their posts count.
const TRUSTED_AFTER_POSTS = 5;

// The aliases this module's SQL gives its own tables. A caller's alias must
// differ, or the subqueries would read their own table in its place.
const POST = "trust_post";
const TOPIC = "trust_topic";
const COUNTED = "trust_counted";
const MEMBER = "trust_member";

function checkAlias(users: string): void {
  assert(/^[a-z_][a-z0-9_]*$/.test(users), `Not a plain SQL alias: ${users}`);
  assert(
    ![POST, TOPIC, COUNTED].includes(users),
    `${users} is an alias trustedSql uses itself`,
  );
}

// Whether more than TRUSTED_AFTER_POSTS of the member's aged posts count, as
// SQL over the users row `users` names. Hidden posts and posts in hidden
// topics count only when countHidden is set. The LIMIT ends the scan once a
// veteran qualifies.
function postsQualifySql(users: string, countHidden: boolean): string {
  const visible = countHidden
    ? ""
    : `AND NOT ${POST}.is_hidden AND NOT ${TOPIC}.is_hidden`;
  return `(
    SELECT count(*)
    FROM (
      SELECT 1
      FROM posts ${POST}
      JOIN topics ${TOPIC} ON ${TOPIC}.id = ${POST}.topic_id
      WHERE ${POST}.user_id = ${users}.id
        AND ${POST}.idx > -1
        AND ${POST}.created_at <= clock_timestamp()
          - make_interval(secs => ${config.TRUST_MIN_POST_AGE_SECONDS})
        ${visible}
      LIMIT ${TRUSTED_AFTER_POSTS + 1}
    ) ${COUNTED}
  ) > ${TRUSTED_AFTER_POSTS}`;
}

// The rule, as a SQL boolean over the users row that the alias `users` names,
// for a query that lists members. The text holds only that alias, checked
// above, and integers from this module and server/config.ts, so nothing a
// member sends enters it.
export function trustedSql(users: string): string {
  checkAlias(users);
  return `(
    ${users}.approved_at IS NOT NULL
    OR ${postsQualifySql(users, false)}
  )`;
}

export type Trust = {
  trusted: boolean;
  // Untrusted only because staff hid some of the member's posts or topics:
  // counting those, more than TRUSTED_AFTER_POSTS of their posts are aged.
  // server/services/antispam/policy.ts#decideAction never NUKEs such a member.
  demoted: boolean;
};

// Reads one member's standing from live rows. A write that depends on it
// reads it under the member's lockSender, through lockStanding.
export async function readTrust(
  client: pg.Pool | pg.PoolClient,
  userId: number,
): Promise<Trust> {
  assert(Number.isInteger(userId));
  return client
    .query<Trust>(
      `
      SELECT trusted, NOT trusted AND qualified_counting_hidden AS demoted
      FROM (
        SELECT
          ${trustedSql(MEMBER)} AS trusted,
          ${postsQualifySql(MEMBER, true)} AS qualified_counting_hidden
        FROM users ${MEMBER}
        WHERE ${MEMBER}.id = $1
      ) standing
    `,
      [userId],
    )
    .then(exactlyOneRow);
}

export async function isTrustedMember(
  client: pg.Pool | pg.PoolClient,
  userId: number,
): Promise<boolean> {
  return (await readTrust(client, userId)).trusted;
}
