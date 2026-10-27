// The one way to run a viewer's paged listing of posts or topics that spans
// topics. It adds the viewer's read scope to the query in SQL, before any
// LIMIT, OFFSET or cap, so page sizes say nothing about rows the viewer may
// not read. Then it asks cancan about every row and throws on the first one
// the viewer cannot read. A by-id load of one topic or forum goes through
// server/db/readable.ts instead.
//
// cancan stays the judge and stays free of SQL. Each scope flag below opens
// for a viewer through the same cancan function its rule calls, and keeps its
// SQL clause beside the matching row test. The scope is stricter than cancan
// for some non-staff viewers, who still reach those rows by opening the
// topic; server/readable.test.ts#stricterThanCancan pins exactly where.
//
// The topic page (db.findPostsByTopicId) stays out. It pages one topic the
// viewer already passed READ_TOPIC for and asks READ_POST about each post, so
// GMs keep reading hidden posts in their own topics there.

import assert from "node:assert";
import type { Knex } from "knex";

import * as cancan from "./cancan";
import { pool } from "./db/util";

export type ReadAction = "READ_POST" | "READ_TOPIC";

// The base query's table aliases that the scope clauses name, per action
type AliasesFor = {
  READ_POST: { posts: string; topics: string; forums: string };
  READ_TOPIC: { topics: string; forums: string };
};

// One rule a listing must follow for a viewer: some rows are held back
// unless the viewer may read them
type Flag<A extends ReadAction> = {
  // Whether the viewer may read the rows this flag holds back
  opensFor: (viewer: any) => boolean;
  // Whether a row is one this flag holds back: the JS reading of `holdBack`
  holds: (row: any) => boolean;
  // Adds the WHERE clause that holds those rows back
  holdBack: (query: Knex.QueryBuilder, aliases: AliasesFor[A]) => void;
};

function isStaff(viewer: any): boolean {
  return !!viewer && cancan.isStaffRole(viewer.role);
}

// Rows in Lexus Lounge forums. Both actions' rows carry their forum.
function loungeFlag<A extends ReadAction>(
  opensFor: (viewer: any) => boolean,
): Flag<A> {
  return {
    opensFor,
    holds: (row) => cancan.isModForum(row.forum),
    holdBack: (query, aliases) => {
      query.where(
        `${aliases.forums}.category_id`,
        "<>",
        cancan.MOD_CATEGORY_ID,
      );
    },
  };
}

// Rows in hidden topics. `topicOf` finds the topic in a row.
function hiddenTopicFlag<A extends ReadAction>(
  topicOf: (row: any) => any,
): Flag<A> {
  return {
    opensFor: isStaff,
    holds: (row) => topicOf(row).is_hidden,
    holdBack: (query, aliases) => {
      query.where(`${aliases.topics}.is_hidden`, false);
    },
  };
}

const SCOPES: { [A in ReadAction]: Flag<A>[] } = {
  READ_POST: [
    // READ_POST answers lounge posts with LEXUS_LOUNGE alone
    loungeFlag((viewer) => cancan.can(viewer, "LEXUS_LOUNGE")),
    // READ_POST lets staff read posts in hidden topics, and hidden posts
    hiddenTopicFlag((post) => post.topic),
    {
      opensFor: isStaff,
      holds: (post) => post.is_hidden,
      holdBack: (query, aliases) => {
        query.where(`${aliases.posts}.is_hidden`, false);
      },
    },
  ],
  READ_TOPIC: [
    // READ_TOPIC and READ_FORUM share one list of who may enter the lounge
    loungeFlag(cancan.mayEnterModForums),
    // READ_TOPIC lets staff read hidden topics
    hiddenTopicFlag((topic) => topic),
  ],
};

function scope<A extends ReadAction>(
  viewer: any,
  action: A,
  base: Knex.QueryBuilder,
  aliases: AliasesFor[A],
): Knex.QueryBuilder {
  const scoped = base.clone();
  for (const flag of SCOPES[action] as Flag<A>[]) {
    if (!flag.opensFor(viewer)) flag.holdBack(scoped, aliases);
  }
  return scoped;
}

// Whether the scope lets a row through for a viewer: the JS reading of the
// clauses scope() adds, which server/readable.test.ts checks against cancan
export function scopeAdmits(
  viewer: any,
  action: ReadAction,
  row: any,
): boolean {
  return (SCOPES[action] as Flag<ReadAction>[]).every(
    (flag) => flag.opensFor(viewer) || !flag.holds(row),
  );
}

// Runs a listing for a viewer. `base` is the query that holds the rows and
// any cap; the scope goes on it. `wrap`, if given, puts the scoped base
// inside an outer query (ranking, paging) and must not widen it. Every row
// must pass cancan.can(viewer, action, row), so rows carry what
// server/cancan.ts#TARGETS declares for the action, or can() throws.
export async function fetchReadable<A extends ReadAction>(
  viewer: any,
  action: A,
  base: Knex.QueryBuilder,
  opts: AliasesFor[A] & {
    wrap?: (scoped: Knex.QueryBuilder) => Knex.QueryBuilder;
  },
): Promise<any[]> {
  const scoped = scope(viewer, action, base, opts);
  const query = opts.wrap ? opts.wrap(scoped) : scoped;
  const { rows } = await pool.query(query.toString());
  for (const row of rows) {
    assert(
      cancan.can(viewer, action, row),
      `${action} scope let through row ${row.id} that the viewer cannot read`,
    );
  }
  return rows;
}
