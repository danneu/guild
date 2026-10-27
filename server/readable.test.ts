import Knex from "knex";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { can, MOD_CATEGORY_ID } from "./cancan";
import {
  ActorName,
  actorNames,
  actors,
  forumColumns,
  postRow,
  topicRow,
} from "./cancan.fixtures";
import { pool } from "./db/util";
import { fetchReadable, ReadAction, scopeAdmits } from "./readable";

const knex = Knex({ client: "pg" });

// The repo has no real-database tests, so these read the SQL the owner sends
// and feed it rows by hand.
vi.mock("./db/util", () => ({
  pool: { query: vi.fn() },
}));

const query = vi.mocked(pool.query) as any;

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

////////////////////////////////////////////////////////////
// The sweep: every viewer against every kind of row cancan tells apart

// The forums READ_POST and READ_TOPIC treat differently
const forums = {
  plain: forumColumns(),
  contest: forumColumns({ id: 45, title: "Contests" }),
  arena: forumColumns({ id: 6, title: "Arena Roleplay" }),
  pw: forumColumns({ id: 49, title: "Nation Roleplay" }),
  lounge: forumColumns({
    id: 10,
    category_id: MOD_CATEGORY_ID,
    title: "Mod Discussion",
  }),
};
type ForumName = keyof typeof forums;
const forumNames = Object.keys(forums) as ForumName[];

type Cell = { label: string; row: unknown };

function topicFor(forum: ForumName, topicHidden: boolean) {
  return topicRow({
    forum_id: forums[forum].id,
    forum: forums[forum],
    is_hidden: topicHidden,
  });
}

function label(forum: ForumName, topicHidden: boolean, postHidden = false) {
  return [
    forum,
    topicHidden ? "hidden-topic" : null,
    postHidden ? "hidden-post" : null,
  ]
    .filter(Boolean)
    .join(" ");
}

const cells: Record<ReadAction, Cell[]> = {
  READ_POST: forumNames.flatMap((forum) =>
    [false, true].flatMap((topicHidden) =>
      [false, true].map((postHidden) => ({
        label: label(forum, topicHidden, postHidden),
        row: postRow(topicFor(forum, topicHidden), { is_hidden: postHidden }),
      })),
    ),
  ),
  READ_TOPIC: forumNames.flatMap((forum) =>
    [false, true].map((topicHidden) => ({
      label: label(forum, topicHidden),
      row: topicFor(forum, topicHidden),
    })),
  ),
};

const actions: ReadAction[] = ["READ_POST", "READ_TOPIC"];

// "<viewer> <row label>" for each cell where both tests hold
function where(
  action: ReadAction,
  test: (viewer: ActorName, row: unknown) => boolean,
): string[] {
  return actorNames.flatMap((viewer) =>
    cells[action]
      .filter((cell) => test(viewer, cell.row))
      .map((cell) => `${viewer} ${cell.label}`),
  );
}

function expand(viewers: ActorName[], rows: string[]): string[] {
  return viewers.flatMap((viewer) => rows.map((row) => `${viewer} ${row}`));
}

const hiddenSuffixes = [
  "hidden-post",
  "hidden-topic",
  "hidden-topic hidden-post",
];
function hiddenIn(...forumList: ForumName[]): string[] {
  return forumList.flatMap((forum) =>
    hiddenSuffixes.map((suffix) => `${forum} ${suffix}`),
  );
}

// Rows cancan lets a viewer read that their listings leave out. They can
// still open each one from its topic. A change here is a change in who loses
// what, so it shows up in review.
const stricterThanCancan: Record<ReadAction, string[]> = {
  READ_POST: [
    // GMs and co-GMs read hidden posts and posts in hidden topics in their
    // own topics, on the topic page
    ...expand(["gm", "coGm"], hiddenIn("plain", "contest", "arena", "pw")),
    // Boutique mods read them in their own forums
    ...expand(["conmod"], hiddenIn("contest")),
    ...expand(["arenamod"], hiddenIn("arena")),
    ...expand(["pwmod"], hiddenIn("pw")),
  ],
  READ_TOPIC: [
    // Listing rows do not load a forum's mods, so forum mods lose nothing
    // in practice
    ...expand(
      ["forumMod"],
      ["plain", "contest", "arena", "pw"].map((f) => `${f} hidden-topic`),
    ),
    ...expand(["conmod"], ["contest hidden-topic", "lounge hidden-topic"]),
    ...expand(["arenamod"], ["arena hidden-topic", "lounge hidden-topic"]),
    ...expand(["pwmod"], ["pw hidden-topic"]),
  ],
};

describe("the read scope", () => {
  for (const action of actions) {
    // Intent: SQL never lets through a row cancan would deny.
    // Why it exists: fetchReadable throws on such a row, so a scope looser
    // than cancan turns the listing into a 500.
    // Scenario: any viewer, any forum kind, hidden or not.
    it(`admits only rows ${action} lets the viewer read`, () => {
      expect(
        where(
          action,
          (viewer, row) =>
            scopeAdmits(actors[viewer], action, row) &&
            !can(actors[viewer], action, row),
        ),
      ).toEqual([]);
    });

    it(`is stricter than ${action} only where pinned`, () => {
      expect(
        where(
          action,
          (viewer, row) =>
            can(actors[viewer], action, row) &&
            !scopeAdmits(actors[viewer], action, row),
        ).sort(),
      ).toEqual([...stricterThanCancan[action]].sort());
    });
  }
});

////////////////////////////////////////////////////////////
// The SQL each flag adds

const loungeClause = `"f"."category_id" <> ${MOD_CATEGORY_ID}`;
const hiddenTopicClause = `"t"."is_hidden" = false`;
const hiddenPostClause = `"p"."is_hidden" = false`;
const allClauses = [loungeClause, hiddenTopicClause, hiddenPostClause];

function postListing() {
  return knex("posts as p")
    .join("topics as t", "p.topic_id", "t.id")
    .join("forums as f", "t.forum_id", "f.id");
}

function topicListing() {
  return knex("topics as t").join("forums as f", "t.forum_id", "f.id");
}

async function sentSql(viewer: ActorName, action: ReadAction) {
  if (action === "READ_POST") {
    await fetchReadable(actors[viewer], action, postListing(), {
      posts: "p",
      topics: "t",
      forums: "f",
    });
  } else {
    await fetchReadable(actors[viewer], action, topicListing(), {
      topics: "t",
      forums: "f",
    });
  }
  expect(query).toHaveBeenCalledTimes(1);
  return query.mock.calls[0][0] as string;
}

describe("fetchReadable", () => {
  const closed: [ActorName, ReadAction, string[]][] = [
    ["guest", "READ_POST", allClauses],
    ["member", "READ_POST", allClauses],
    // LEXUS_LOUNGE keeps conmods out of lounge posts
    ["conmod", "READ_POST", allClauses],
    ["mod", "READ_POST", []],
    ["guest", "READ_TOPIC", [loungeClause, hiddenTopicClause]],
    ["member", "READ_TOPIC", [loungeClause, hiddenTopicClause]],
    // READ_TOPIC lets conmods into the lounge
    ["conmod", "READ_TOPIC", [hiddenTopicClause]],
    ["mod", "READ_TOPIC", []],
  ];

  for (const [viewer, action, clauses] of closed) {
    it(`adds the clause of each flag closed to a ${viewer} on ${action}`, async () => {
      const sql = await sentSql(viewer, action);
      for (const clause of allClauses) {
        if (clauses.includes(clause)) expect(sql).toContain(clause);
        else expect(sql).not.toContain(clause);
      }
    });
  }

  it("returns the rows when the viewer may read every one", async () => {
    const row = postRow(topicFor("plain", false));
    query.mockResolvedValue({ rows: [row] });

    await expect(
      fetchReadable(actors.member, "READ_POST", postListing(), {
        posts: "p",
        topics: "t",
        forums: "f",
      }),
    ).resolves.toEqual([row]);
  });

  // Intent: a row the viewer cannot read never leaves the owner.
  // Why it exists: the scope translates cancan by hand; if the two drift,
  // the listing must fail loudly rather than show the row.
  // Scenario: the database returns a lounge post to a member.
  it("throws before returning a row the viewer cannot read", async () => {
    query.mockResolvedValue({
      rows: [
        postRow(topicFor("plain", false)),
        postRow(topicFor("lounge", false)),
      ],
    });

    await expect(
      fetchReadable(actors.member, "READ_POST", postListing(), {
        posts: "p",
        topics: "t",
        forums: "f",
      }),
    ).rejects.toThrow(/READ_POST scope let through/);
  });
});
