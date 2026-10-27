import { describe, expect, it } from "vitest";

import {
  can,
  CanAction,
  MOD_CATEGORY_ID,
  visibleRegistrationIp,
} from "./cancan";
import {
  ActorName,
  actorNames,
  actors,
  asJson,
  forumColumns,
  plainForumColumns,
  postRow,
  topicRow,
} from "./cancan.fixtures";

function allowed(action: CanAction, target: unknown): ActorName[] {
  return actorNames.filter((name) => can(actors[name], action, target));
}

// Lists actors in sweep order, so expectations read as sets.
function only(...names: ActorName[]): ActorName[] {
  return actorNames.filter((name) => names.includes(name));
}

const everyone = actorNames;
const staff: ActorName[] = ["mod", "smod", "admin"];

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

const topics = {
  plain: topicRow(),
  lounge: topicRow({ id: 2, forum_id: 10, forum: loungeForumColumns }),
  hidden: topicRow({ id: 3, is_hidden: true }),
  closed: topicRow({ id: 4, is_closed: true }),
};

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

describe("declared targets", () => {
  // Intent: can() throws on an actor or a target that lacks a field its rule
  // reads, for every caller, instead of reading the field as undefined.
  // Why it exists: rules read a missing field as "no bans", "not lounge",
  // "not hidden" or "no mods", and that allowed (hunts 261026-0911-021, -022
  // and -032).
  // Scenario: a loader selects too few columns, or a route or view passes a
  // hand-built object.
  it("throws on an actor without a role", () => {
    expect(() =>
      can({ id: actors.member.id }, "SUBSCRIBE_TOPIC", topics.plain),
    ).toThrow(/role/);
  });

  function without<T extends object>(row: T, key: keyof T) {
    const { [key]: _dropped, ...rest } = row;
    return rest;
  }

  it.each<[CanAction, string, unknown, ActorName]>([
    ["READ_TOPIC", "is_hidden", without(topics.hidden, "is_hidden"), "guest"],
    ["READ_TOPIC", "mods", without(topics.hidden, "mods"), "forumMod"],
    ["CREATE_POST", "is_closed", without(topics.closed, "is_closed"), "member"],
    ["READ_POST", "is_hidden", without(posts.hidden, "is_hidden"), "guest"],
    [
      "READ_USER_ONLINE_STATUS",
      "is_ghost",
      { id: actors.member.id, uname: "Member", role: "member" },
      "guest",
    ],
    [
      "UPDATE_PM",
      "legacy_html",
      { id: 1, convo_id: 1, user_id: actors.member.id, markup: "Hi" },
      "member",
    ],
  ])("throws on a %s target without %s", (action, field, target, name) => {
    expect(() => can(actors[name], action, target)).toThrow(new RegExp(field));
  });
});

// A users row (u.*), trimmed to the columns pages and rules read
function userRow(props: Record<string, unknown> = {}) {
  return {
    id: actors.member.id,
    uname: "Member",
    slug: "member",
    role: "member",
    custom_title: null,
    avatar_url: null,
    is_ghost: false,
    is_nuked: false,
    created_at: new Date("2026-01-01T00:00:00Z"),
    last_online_at: new Date("2026-10-01T00:00:00Z"),
    registration_ip: null,
    ...props,
  };
}

// The topics columns (t.*) of a topic row, without what the loaders join on
function topicColumns(topic: ReturnType<typeof topicRow>) {
  const { forum: _forum, mods: _mods, banned_ids: _bans, ...columns } = topic;
  return columns;
}

describe("loader rows", () => {
  // Intent: every loader's row passes each action it feeds, for every actor.
  // Why it exists: can() throws on a target that lacks a declared field
  // (hunt 261026-0911-032), so a schema that asks for a column some loader
  // does not select would turn that page into a 500.
  // Scenario: a rule starts reading a new topic field, its schema declares
  // it, and a topic listing still selects the old columns.
  const topicActions: CanAction[] = [
    "ACCESS_TOPIC_MODKIT",
    "UPDATE_TOPIC",
    "UPDATE_TOPIC_JOIN_STATUS",
    "UPDATE_TOPIC_TAGS",
    "UPDATE_TOPIC_CO_GMS",
    "UPDATE_TOPIC_TITLE",
    "READ_TOPIC",
    "MOVE_TOPIC",
    "STICK_TOPIC",
    "UNSTICK_TOPIC",
    "HIDE_TOPIC",
    "UNHIDE_TOPIC",
    "CLOSE_TOPIC",
    "OPEN_TOPIC",
    "SUBSCRIBE_TOPIC",
    "UNSUBSCRIBE_TOPIC",
    "CREATE_POST",
  ];
  const postActions: CanAction[] = [
    "READ_POST",
    "UPDATE_POST",
    "HIDE_POST",
    "UNHIDE_POST",
    "RATE_POST",
  ];
  const userActions: CanAction[] = [
    "UPDATE_USER",
    "UPDATE_USER_ROLE",
    "GRANT_EMAIL_GATE_EXEMPTION",
    "UPDATE_USER_CUSTOM_TITLE",
    "READ_USER_ONLINE_STATUS",
    "READ_USER_PM_SENT_COUNT",
    "READ_USER_RATINGS_TABLE",
    "READ_USER_IP",
    "NUKE_USER",
    "CHANGE_UNAME",
    "CREATE_USER_STATUS",
    "MANAGE_USER_STATUS",
    "MANAGE_IMAGES",
    "UPLOAD_IMAGE",
  ];

  const gmUser = userRow({ id: actors.gm.id, uname: "Gm", slug: "gm" });
  // A posts row (p.*), as a listing nests it
  const {
    topic: _postTopic,
    forum: _postForum,
    ...postColumns
  } = posts.visible;
  const latestPost = asJson(postColumns);
  // The full and with-subscription shapes of loadTopicFor
  const fullTopic = topicRow({
    user: asJson(gmUser),
    co_gm_unames: ["CoGm"],
    tags: null,
    is_subscribed: false,
    unread_ic: false,
    unread_ooc: false,
    unread_char: false,
  });
  // findPostsByTopicId gives each post the loaded topic, without its user
  const { user: _topicUser, ...pageTopic } = fullTopic;
  const listedTopic = {
    ...topicColumns(topics.plain),
    forum: plainForumColumns,
    mods: topics.plain.mods,
  };
  const forumListedTopic = {
    ...listedTopic,
    user: asJson(gmUser),
    latest_user: asJson(userRow()),
    latest_post: latestPost,
    tags: null,
  };
  const pm = {
    id: 1,
    convo_id: 1,
    user_id: actors.member.id,
    idx: 0,
    text: null,
    markup: "Hi",
    html: "Hi",
    legacy_html: null,
    ip_address: null,
    created_at: new Date(),
    updated_at: null,
    convo: { id: 1, user_id: actors.member.id, title: "Hi", pms_count: 1 },
  };
  const vm = {
    id: 1,
    from_user_id: actors.member.id,
    to_user_id: actors.gm.id,
    parent_vm_id: null,
    idx: 0,
    markup: "Hi",
    html: "Hi",
    created_at: new Date(),
  };
  const vmFromUser = { uname: "Member", slug: "member", avatar_url: null };

  it.each<[loader: string, row: unknown, actions: CanAction[]]>([
    ["loadTopicFor plain", topics.plain, topicActions],
    ["loadTopicFor full", fullTopic, topicActions],
    ["findTopicsByForumId for a guest", forumListedTopic, ["READ_TOPIC"]],
    [
      "findTopicsByForumId for a member",
      { ...forumListedTopic, has_posted: true, unread_posts: false },
      ["READ_TOPIC"],
    ],
    ["findRecentTopicsForUserId", listedTopic, ["READ_TOPIC"]],
    [
      "findRecentTopicsForUserId opening post",
      postRow(topics.plain, { topic: asJson(topicColumns(topics.plain)) }),
      ["READ_POST"],
    ],
    [
      "listRoleplays",
      { ...listedTopic, user: { uname: "Gm", slug: "gm" } },
      ["READ_TOPIC"],
    ],
    ["findPostById", posts.visible, postActions],
    [
      "findPostsByTopicId",
      postRow(topics.plain, {
        user: asJson(userRow()),
        ratings: [],
        topic: pageTopic,
        forum: pageTopic.forum,
      }),
      postActions,
    ],
    [
      "findPostsByTopicId post user",
      {
        id: actors.member.id,
        uname: "Member",
        role: "member",
        is_ghost: false,
      },
      ["READ_USER_ONLINE_STATUS"],
    ],
    [
      "findRecentPostsForUserId",
      postRow(topics.plain, { topic: asJson(topicColumns(topics.plain)) }),
      ["READ_POST"],
    ],
    [
      "search",
      postRow(topics.plain, {
        user: asJson(userRow()),
        topic: asJson(topicColumns(topics.plain)),
      }),
      ["READ_POST"],
    ],
    [
      "notification post target",
      {
        id: 1001,
        idx: 0,
        type: "ooc",
        html: "Hello",
        is_hidden: false,
        user_id: actors.member.id,
        topic_id: topics.plain.id,
        topic: asJson(listedTopic),
        forum: asJson(plainForumColumns),
      },
      ["READ_POST"],
    ],
    ["notification topic target", asJson(listedTopic), ["READ_TOPIC"]],
    ["loadForumFor", forums.plain, ["READ_FORUM", "CREATE_TOPIC"]],
    ["findCategoriesWithForums", categories.plain, ["READ_CATEGORY"]],
    ["findUserById", userRow(), userActions],
    [
      "findStatusById",
      {
        id: 1,
        user_id: actors.member.id,
        text: "Hi",
        html: "Hi",
        liked_user_ids: [actors.gm.id],
        created_at: new Date(),
        user: asJson(userRow()),
      },
      ["LIKE_STATUS", "DELETE_USER_STATUS"],
    ],
    [
      "vms.getVmById",
      { ...vm, from_user: asJson(userRow()), to_user: asJson(gmUser) },
      ["DELETE_VM"],
    ],
    [
      "findLatestVMsForUserId",
      { ...vm, from_user: { ...vmFromUser, role: "member" }, child_vms: [] },
      ["DELETE_VM"],
    ],
    [
      "findLatestVMsForUserId child",
      asJson({
        ...vm,
        id: 2,
        parent_vm_id: 1,
        from_user: { ...vmFromUser, url: "/users/member", role: "member" },
      }),
      ["DELETE_VM"],
    ],
    [
      "convos.getConvos",
      {
        id: 1,
        user_id: actors.member.id,
        title: "Hi",
        created_at: new Date(),
        user: asJson(userRow()),
        participants: [asJson(userRow()), asJson(gmUser)],
      },
      ["READ_CONVO", "DELETE_CONVO", "CREATE_PM"],
    ],
    ["findPmById", pm, ["UPDATE_PM"]],
    [
      "findPmWithConvo",
      { ...pm, participants: [asJson(userRow()), asJson(gmUser)] },
      ["READ_PM", "UPDATE_PM"],
    ],
    [
      "findNotificationById",
      {
        id: 1,
        type: "REPLY_VM",
        from_user_id: actors.gm.id,
        to_user_id: actors.member.id,
        count: 1,
        created_at: new Date(),
      },
      ["DELETE_NOTIFICATION"],
    ],
    [
      "campaign",
      {
        id: 1,
        user_id: actors.gm.id,
        title: "A campaign",
        created_at: new Date(),
      },
      ["READ_CAMPAIGN", "UPDATE_CAMPAIGN", "CREATE_ROLL"],
    ],
    ["topic ban", { topic: topics.plain, user: userRow() }, ["TOPIC_BAN"]],
  ])("%s rows pass every action they feed", (_loader, row, actions) => {
    for (const name of actorNames) {
      for (const action of actions) {
        expect(() => can(actors[name], action, row)).not.toThrow();
      }
    }
  });
});

describe("banned users", () => {
  const bannedGm = { ...actors.gm, role: "banned" };
  const bannedForumMod = { ...actors.forumMod, role: "banned" };
  const zeroth = postRow(topics.plain, {
    id: 1006,
    idx: -1,
    user_id: actors.gm.id,
  });

  // Intent: cancan offers a banned GM or forum mod none of their old controls.
  // Why it exists: these rules had no banned line, and the routes behind them
  // ask nothing else, so a banned GM could change co-GMs, tags and the 0th
  // post's visibility, and a banned forum mod could change topic status
  // (hunt 261026-0911-028). requireNotBanned now refuses those writes; these
  // answers keep the UI from offering them.
  // Scenario: a GM or a forum mod is site-banned and opens their topic.
  it.each<[CanAction, unknown]>([
    ["UPDATE_TOPIC_CO_GMS", topics.plain],
    ["UPDATE_TOPIC_TAGS", topics.plain],
    ["UPDATE_TOPIC_JOIN_STATUS", topics.plain],
    ["HIDE_POST", zeroth],
    ["UNHIDE_POST", posts.hiddenZeroth],
  ])("refuses %s to a GM once banned", (action, target) => {
    expect(can(actors.gm, action, target)).toBe(true);
    expect(can(bannedGm, action, target)).toBe(false);
  });

  it.each<CanAction>([
    "STICK_TOPIC",
    "UNSTICK_TOPIC",
    "HIDE_TOPIC",
    "UNHIDE_TOPIC",
    "CLOSE_TOPIC",
    "OPEN_TOPIC",
    "ACCESS_TOPIC_MODKIT",
  ])("refuses %s to a forum mod once banned", (action) => {
    expect(can(actors.forumMod, action, topics.plain)).toBe(true);
    expect(can(bannedForumMod, action, topics.plain)).toBe(false);
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
  // Scenario: a loader selects the topic or post without BANNED_IDS_JSON.
  it("fails closed on a row without banned_ids", () => {
    const { banned_ids: _topicBans, ...shortTopic } = topics.plain;
    const shortPost = postRow(shortTopic as ReturnType<typeof topicRow>);

    for (const name of actorNames) {
      const actor = actors[name];
      expect(() => can(actor, "CREATE_POST", shortTopic)).toThrow(/banned_ids/);
      expect(() => can(actor, "UPDATE_POST", shortPost)).toThrow(/banned_ids/);
    }
  });
});
