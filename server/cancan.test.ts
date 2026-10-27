import { describe, expect, it } from "vitest";

import {
  can,
  CanAction,
  MOD_CATEGORY_ID,
  visibleRegistrationIp,
} from "./cancan";

// Viewers for the READ_GATE sweep. The forum mod, GM, co-GM and post author
// are plain members; only the fixtures below give them their part.
const actors = {
  guest: undefined,
  banned: { id: 101, uname: "Banned", role: "banned" },
  member: { id: 102, uname: "Member", role: "member" },
  forumMod: { id: 103, uname: "ForumMod", role: "member" },
  gm: { id: 104, uname: "Gm", role: "member" },
  coGm: { id: 105, uname: "CoGm", role: "member" },
  conmod: { id: 106, uname: "Conmod", role: "conmod" },
  arenamod: { id: 107, uname: "Arenamod", role: "arenamod" },
  pwmod: { id: 108, uname: "Pwmod", role: "pwmod" },
  mod: { id: 109, uname: "Mod", role: "mod" },
  smod: { id: 110, uname: "Smod", role: "smod" },
  admin: { id: 111, uname: "Admin", role: "admin" },
};
type ActorName = keyof typeof actors;
const actorNames = Object.keys(actors) as ActorName[];

function allowed(action: CanAction, target: unknown): ActorName[] {
  return actorNames.filter((name) => can(actors[name], action, target));
}

// Lists actors in sweep order, so expectations read as sets.
function only(...names: ActorName[]): ActorName[] {
  return actorNames.filter((name) => names.includes(name));
}

const everyone = actorNames;
const staff: ActorName[] = ["mod", "smod", "admin"];

// A forums row (f.*). Forum 4 is Casual Roleplay in category 2, so a rule
// that compares a forum id to the lounge category id shows up.
function forumColumns(props: Record<string, unknown> = {}) {
  return {
    id: 4,
    category_id: 2,
    parent_forum_id: null,
    title: "Casual Roleplay",
    description: null,
    pos: 0,
    is_roleplay: true,
    has_tags_enabled: true,
    tab_title: null,
    is_check: false,
    is_hidden: false,
    topics_count: 1,
    posts_count: 1,
    ...props,
  };
}

const plainForumColumns = forumColumns();
const loungeForumColumns = forumColumns({
  id: 10,
  category_id: MOD_CATEGORY_ID,
  title: "Lexus Lounge",
});

// loadForumFor's plain shape (server/db/readable.ts#findForumById): f.*, the
// forum's mods, and its child and parent forums
const forums = {
  plain: {
    ...plainForumColumns,
    mods: [],
    child_forum: null,
    parent_forum: null,
  },
  lounge: {
    ...loungeForumColumns,
    mods: [],
    child_forum: null,
    parent_forum: null,
  },
};

// loadTopicFor's plain shape (server/db/readable.ts#findTopic): t.*, the
// forum, the forum's mods, and the topic's banned_ids
function topicRow(props: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "A roleplay",
    user_id: actors.gm.id,
    forum_id: 4,
    created_at: new Date("2026-10-01T00:00:00Z"),
    is_roleplay: true,
    co_gm_ids: [actors.coGm.id],
    join_status: "jump-in",
    is_hidden: false,
    is_closed: false,
    is_sticky: false,
    posts_count: 2,
    ic_posts_count: 0,
    ooc_posts_count: 2,
    char_posts_count: 0,
    moved_from_forum_id: null,
    moved_at: null,
    latest_post_at: new Date(),
    forum: plainForumColumns,
    banned_ids: [] as number[],
    mods: [{ id: actors.forumMod.id, uname: "ForumMod", slug: "forummod" }],
    ...props,
  };
}

const topics = {
  plain: topicRow(),
  lounge: topicRow({ id: 2, forum_id: 10, forum: loungeForumColumns }),
  hidden: topicRow({ id: 3, is_hidden: true }),
  closed: topicRow({ id: 4, is_closed: true }),
};

// db.findPostById rows: p.*, the topic as to_json(t.*) (no forum or mods),
// the forum, and the topic's banned_ids. The member wrote every post but the
// zeroth one, which belongs to the GM.
function postRow(
  topic: ReturnType<typeof topicRow>,
  props: Record<string, unknown> = {},
) {
  const { forum, banned_ids, mods: _mods, ...topicColumns } = topic;
  return {
    id: 1001,
    text: null,
    markup: "Hello",
    html: "Hello",
    legacy_html: null,
    topic_id: topic.id,
    user_id: actors.member.id,
    created_at: new Date("2026-10-01T00:00:00Z"),
    updated_at: null,
    is_roleplay: true,
    type: "ooc",
    ip_address: null,
    is_hidden: false,
    rev_count: 1,
    idx: 0,
    topic: topicColumns,
    forum,
    banned_ids,
    ...props,
  };
}

const posts = {
  visible: postRow(topics.plain),
  hidden: postRow(topics.plain, { id: 1002, is_hidden: true }),
  inHiddenTopic: postRow(topics.hidden, { id: 1003 }),
  lounge: postRow(topics.lounge, { id: 1004 }),
  hiddenZeroth: postRow(topics.plain, {
    id: 1005,
    idx: -1,
    user_id: actors.gm.id,
    is_hidden: true,
  }),
};

type Sweep<T> = [action: CanAction, expected: Record<keyof T, ActorName[]>];

// Every action READ_GATE gates on a topic, plus the gate itself
const topicSweep: Sweep<typeof topics>[] = [
  [
    "READ_TOPIC",
    {
      plain: everyone,
      lounge: only("conmod", "arenamod", ...staff),
      hidden: only("forumMod", ...staff),
      closed: everyone,
    },
  ],
  [
    "CREATE_POST",
    {
      plain: only(
        "member",
        "forumMod",
        "gm",
        "coGm",
        "conmod",
        "arenamod",
        "pwmod",
        ...staff,
      ),
      // Members, forum mods and pwmods cannot read lounge topics
      lounge: only("conmod", "arenamod", ...staff),
      // Boutique mods cannot read hidden topics outside their forums
      hidden: only("forumMod", ...staff),
      closed: only("forumMod", "conmod", "arenamod", "pwmod", ...staff),
    },
  ],
  [
    "SUBSCRIBE_TOPIC",
    {
      plain: only(
        "member",
        "forumMod",
        "gm",
        "coGm",
        "conmod",
        "arenamod",
        "pwmod",
        ...staff,
      ),
      lounge: only("conmod", "arenamod", ...staff),
      hidden: only("forumMod", ...staff),
      closed: only(
        "member",
        "forumMod",
        "gm",
        "coGm",
        "conmod",
        "arenamod",
        "pwmod",
        ...staff,
      ),
    },
  ],
  [
    "UPDATE_TOPIC",
    {
      plain: only("gm", "coGm", ...staff),
      lounge: staff,
      hidden: staff,
      closed: staff,
    },
  ],
  // GMs cannot edit a topic once it is hidden or moved into the lounge
  ...(
    [
      "UPDATE_TOPIC_JOIN_STATUS",
      "UPDATE_TOPIC_TAGS",
      "UPDATE_TOPIC_TITLE",
    ] as CanAction[]
  ).map(
    (action): Sweep<typeof topics> => [
      action,
      {
        plain: only("gm", "coGm", ...staff),
        lounge: staff,
        hidden: staff,
        closed: only("gm", "coGm", ...staff),
      },
    ],
  ),
  [
    "UPDATE_TOPIC_CO_GMS",
    {
      plain: only("gm", ...staff),
      lounge: staff,
      hidden: staff,
      closed: only("gm", ...staff),
    },
  ],
  ["MOVE_TOPIC", { plain: staff, lounge: staff, hidden: staff, closed: staff }],
  // A member who moderates a lounge forum cannot read its topics either
  ...(
    [
      "STICK_TOPIC",
      "UNSTICK_TOPIC",
      "HIDE_TOPIC",
      "UNHIDE_TOPIC",
      "CLOSE_TOPIC",
      "OPEN_TOPIC",
    ] as CanAction[]
  ).map(
    (action): Sweep<typeof topics> => [
      action,
      {
        plain: only("forumMod", ...staff),
        lounge: staff,
        hidden: only("forumMod", ...staff),
        closed: only("forumMod", ...staff),
      },
    ],
  ),
];

const forumSweep: Sweep<typeof forums>[] = [
  [
    "READ_FORUM",
    { plain: everyone, lounge: only("conmod", "arenamod", ...staff) },
  ],
  [
    "CREATE_TOPIC",
    {
      // pwmods can create topics in forum 4 (hunt 261026-0911-023)
      plain: only(
        "member",
        "forumMod",
        "gm",
        "coGm",
        "conmod",
        "arenamod",
        "pwmod",
        ...staff,
      ),
      lounge: only("conmod", "arenamod", ...staff),
    },
  ],
];

// db.findCategoriesWithForums rows (c.* plus the forums), which the homepage
// asks READ_CATEGORY about
function categoryRow(props: Record<string, unknown> = {}) {
  return {
    id: 2,
    title: "Roleplay",
    description: null,
    pos: 1,
    forums: [plainForumColumns],
    ...props,
  };
}

const categories = {
  plain: categoryRow(),
  lounge: categoryRow({
    id: MOD_CATEGORY_ID,
    title: "Mod Forums",
    forums: [loungeForumColumns],
  }),
};

const categorySweep: Sweep<typeof categories>[] = [
  [
    "READ_CATEGORY",
    { plain: everyone, lounge: only("conmod", "arenamod", ...staff) },
  ],
];

const postSweep: Sweep<typeof posts>[] = [
  [
    "READ_POST",
    {
      visible: everyone,
      // GMs and co-GMs read hidden posts in their own topic
      hidden: only("gm", "coGm", ...staff),
      inHiddenTopic: only("gm", "coGm", ...staff),
      lounge: staff,
      hiddenZeroth: only("gm", "coGm", ...staff),
    },
  ],
  [
    "UPDATE_POST",
    {
      visible: only("member", "admin"),
      // Authors cannot edit their posts once they cannot read them
      hidden: only("admin"),
      inHiddenTopic: only("admin"),
      lounge: only("admin"),
      hiddenZeroth: only("gm", "coGm", "admin"),
    },
  ],
  [
    "HIDE_POST",
    {
      visible: only("conmod", "arenamod", "pwmod", ...staff),
      hidden: staff,
      inHiddenTopic: staff,
      // Boutique mods cannot hide staff lounge posts
      lounge: staff,
      hiddenZeroth: only("gm", "coGm", ...staff),
    },
  ],
  [
    "UNHIDE_POST",
    {
      visible: only("conmod", "arenamod", ...staff),
      // conmods and arenamods cannot unhide posts they cannot read
      hidden: staff,
      inHiddenTopic: staff,
      lounge: staff,
      hiddenZeroth: only("gm", "coGm", ...staff),
    },
  ],
  [
    "RATE_POST",
    {
      visible: only(
        "forumMod",
        "gm",
        "coGm",
        "conmod",
        "arenamod",
        "pwmod",
        ...staff,
      ),
      hidden: only("gm", "coGm", ...staff),
      inHiddenTopic: only("gm", "coGm", ...staff),
      lounge: staff,
      hiddenZeroth: only("coGm", ...staff),
    },
  ],
];

function sweep<T extends Record<string, unknown>>(
  kind: string,
  targets: T,
  table: Sweep<T>[],
) {
  for (const [action, expected] of table) {
    for (const label of Object.keys(expected) as (keyof T & string)[]) {
      it(`${action} on the ${label} ${kind}`, () => {
        expect(allowed(action, targets[label])).toEqual(expected[label]);
      });
    }
  }
}

describe("READ_GATE", () => {
  sweep("topic", topics, topicSweep);
  sweep("forum", forums, forumSweep);
  sweep("post", posts, postSweep);

  // Intent: the lounge test throws on a row that lacks forum.category_id.
  // Why it exists: a missing field used to read as "not lounge", which
  // allowed (hunt 261026-0911-021).
  // Scenario: a loader selects too few forum columns, or a caller passes a
  // topic where its forum belongs.
  it("fails closed on a row without forum.category_id", () => {
    const { category_id: _categoryId, ...shortForum } = forums.plain;
    const shortTopic = topicRow({ forum: shortForum });
    const shortPost = postRow(shortTopic);

    for (const name of actorNames) {
      const actor = actors[name];
      expect(() => can(actor, "READ_FORUM", shortForum)).toThrow(/category_id/);
      expect(() => can(actor, "READ_FORUM", topics.plain)).toThrow(
        /category_id/,
      );
      expect(() => can(actor, "READ_TOPIC", shortTopic)).toThrow(/category_id/);
      expect(() => can(actor, "CREATE_TOPIC", shortForum)).toThrow(
        /category_id/,
      );
      expect(() => can(actor, "CREATE_TOPIC", topics.plain)).toThrow(
        /category_id/,
      );
      expect(() => can(actor, "CREATE_POST", shortTopic)).toThrow(
        /category_id/,
      );
      expect(() => can(actor, "HIDE_POST", shortPost)).toThrow(/category_id/);
    }
  });
});

describe("READ_CATEGORY", () => {
  sweep("category", categories, categorySweep);

  // Intent: a guest asking about the lounge category gets an answer.
  // Why it exists: READ_CATEGORY read user.role with no guest check, so a
  // guest made it throw a TypeError (hunt 261026-0911-023). The homepage
  // strips the lounge category before it asks, which hid the crash.
  // Scenario: a view asks READ_CATEGORY about every category for a guest.
  it("does not throw for a guest on the lounge category", () => {
    expect(() =>
      can(actors.guest, "READ_CATEGORY", categories.lounge),
    ).not.toThrow();
  });
});

describe("CREATE_POST", () => {
  // Intent: a member cannot post into a Lexus Lounge topic.
  // Why it exists: CREATE_POST read topic.category_id, which a topic row
  // never has, so any member could post into the staff forum by id
  // (hunt 261026-0911-021).
  // Scenario: POST /topics/:topicSlug/posts loads the topic with
  // db.loadTopicFor(viewer, id, "plain"), which selects the forum's mods.
  it("keeps members out of Lexus Lounge topics", () => {
    const loungeTopic = {
      id: 1,
      title: "Staff talk",
      user_id: 2,
      forum_id: 10,
      is_roleplay: false,
      co_gm_ids: [],
      is_hidden: false,
      is_closed: false,
      is_sticky: false,
      latest_post_at: new Date(),
      forum: { id: 10, category_id: 4, is_roleplay: false },
      banned_ids: [],
      mods: [],
    };
    const member = { id: 3, uname: "Member", role: "member" };

    expect(can(member, "CREATE_POST", loungeTopic)).toBe(false);
  });
});

// Another account of each role. No actor shares its id, so these are never
// self-edits.
function otherUser(role: string) {
  return { id: 200, uname: "Other", role };
}

const otherUsers = {
  banned: otherUser("banned"),
  member: otherUser("member"),
  conmod: otherUser("conmod"),
  arenamod: otherUser("arenamod"),
  pwmod: otherUser("pwmod"),
  mod: otherUser("mod"),
  smod: otherUser("smod"),
  admin: otherUser("admin"),
};

const userSweep: Sweep<typeof otherUsers>[] = [
  [
    "UPDATE_USER_CUSTOM_TITLE",
    {
      banned: staff,
      member: staff,
      // Mods cannot edit a conmod's or arenamod's profile, title included
      conmod: only("smod", "admin"),
      arenamod: only("smod", "admin"),
      pwmod: staff,
      mod: only("smod", "admin"),
      // Smods cannot retitle each other
      smod: only("admin"),
      admin: only("admin"),
    },
  ],
];

describe("UPDATE_USER_CUSTOM_TITLE", () => {
  // Intent: the title rule never grants more than profile edit.
  // Why it exists: it let mods retitle conmods and arenamods, whose profiles
  // UPDATE_USER keeps them out of (hunt 261026-0911-029).
  // Scenario: a mod sets an arenamod's title.
  sweep("user", otherUsers, userSweep);

  // pwmods and arenamods cannot set their own title; that was the owner's call
  // in hunt 261026-0911-029.
  it("lets each role but banned, pwmod and arenamod set their own title", () => {
    const selfEditors = actorNames.filter(
      (name) =>
        name !== "guest" &&
        can(actors[name], "UPDATE_USER_CUSTOM_TITLE", actors[name]),
    );

    expect(selfEditors).toEqual(
      only("member", "forumMod", "gm", "coGm", "conmod", ...staff),
    );
  });
});

const registrationIp = "203.0.113.42";

function user(props: Record<string, unknown> = {}) {
  return {
    id: 1,
    uname: "User",
    role: "member",
    created_at: new Date("2026-07-04T00:00:00Z"),
    registration_ip: registrationIp,
    ...props,
  };
}

describe("visibleRegistrationIp", () => {
  it("hides IPs before the milestone and shows them on or after it", () => {
    const admin = user({ id: 2, role: "admin" });

    expect(
      visibleRegistrationIp(
        admin,
        user({ created_at: new Date("2026-07-03T23:59:59Z") }),
      ),
    ).toBeNull();
    expect(
      visibleRegistrationIp(
        admin,
        user({ created_at: new Date("2026-07-04T00:00:00Z") }),
      ),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(
        admin,
        user({ created_at: new Date("2026-07-04T00:00:01Z") }),
      ),
    ).toBe(registrationIp);
  });

  it("follows the READ_USER_IP down-chain hierarchy", () => {
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "admin" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "smod" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "mod" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "member" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "banned" })),
    ).toBe(registrationIp);

    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "admin" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "smod" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "mod" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "member" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "banned" })),
    ).toBe(registrationIp);

    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "smod" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "mod" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "member" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "banned" })),
    ).toBe(registrationIp);

    expect(
      visibleRegistrationIp(user({ role: "member" }), user({ role: "member" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(
        user({ id: 3, role: "member" }),
        user({ id: 3, role: "member" }),
      ),
    ).toBeNull();
  });

  it("hides null registration IPs regardless of viewer or date", () => {
    expect(
      visibleRegistrationIp(
        user({ role: "admin" }),
        user({ registration_ip: null }),
      ),
    ).toBeNull();
  });
});

describe("topic bans", () => {
  // Everyone a GM could have banned, plus staff, whose ban rows can predate a
  // promotion.
  const bannedIds = actorNames
    .filter((name) => !["guest", "gm", "coGm"].includes(name))
    .map((name) => actors[name]!.id);
  const topic = topicRow({ banned_ids: bannedIds });

  it("leaves posting to the GMs and the roles a ban never applied to", () => {
    expect(allowed("CREATE_POST", topic)).toEqual(
      only("gm", "coGm", "forumMod", "conmod", "arenamod", "pwmod", ...staff),
    );
  });

  it("stops a banned author editing their post, but not an admin", () => {
    expect(allowed("UPDATE_POST", postRow(topic))).toEqual(only("admin"));
  });

  // Intent: the ban rules throw on a row that lacks banned_ids.
  // Why it exists: a missing list used to read as "no bans", so routes whose
  // loader skipped topic_bans let banned members post and revert
  // (hunt 261026-0911-022).
  // Scenario: a loader selects the topic or post without BANNED_IDS_COLUMN.
  it("fails closed on a row without banned_ids", () => {
    const { banned_ids: _topicBans, ...shortTopic } = topics.plain;
    const { banned_ids: _postBans, ...shortPost } = posts.visible;

    for (const name of actorNames) {
      const actor = actors[name];
      expect(() => can(actor, "CREATE_POST", shortTopic)).toThrow(/banned_ids/);
      expect(() => can(actor, "UPDATE_POST", shortPost)).toThrow(/banned_ids/);
    }
  });
});
