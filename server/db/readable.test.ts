import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "./util";
import {
  ForumShape,
  loadForumFor,
  loadTopicFor,
  TopicLoad,
  TopicShape,
} from "./readable";

// The repo has no real-database tests. This stub answers the by-id topic and
// forum queries like the real ones. It returns a row's mods only when the SQL
// selects them from forum_mods, so a shape that forgets the mods column fails
// the forum-mod cases below.
vi.mock("./util", () => ({
  pool: { query: vi.fn() },
  maybeOneRow: (res: { rows: unknown[] }) => res.rows[0],
}));

////////////////////////////////////////////////////////////
// Fixtures

const loungeForum = { id: 10, title: "Mod Forum", category_id: 4 };
const publicForum = { id: 3, title: "Free Roleplay", category_id: 2 };
const forums = [loungeForum, publicForum];

const guest = null;
const member = { id: 1, uname: "Member", role: "member" };
const forumMod = {
  id: 7,
  uname: "Forum Mod",
  slug: "forum-mod",
  role: "member",
};
const gm = { id: 50, uname: "GM", role: "member" };
const conmod = { id: 20, uname: "Conmod", role: "conmod" };
const arenamod = { id: 21, uname: "Arenamod", role: "arenamod" };
const pwmod = { id: 22, uname: "Pwmod", role: "pwmod" };
const mod = { id: 30, uname: "Mod", role: "mod" };
const smod = { id: 31, uname: "Smod", role: "smod" };
const admin = { id: 32, uname: "Admin", role: "admin" };

const forumModsByForumId: Record<number, object[]> = {
  [publicForum.id]: [
    { id: forumMod.id, uname: forumMod.uname, slug: "forum-mod" },
  ],
};

function topicFixture(props: {
  id: number;
  title: string;
  forum_id: number;
  is_hidden?: boolean;
}) {
  return {
    user_id: gm.id,
    co_gm_ids: [],
    is_hidden: false,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...props,
  };
}

const loungeTopic = topicFixture({
  id: 123,
  title: "Should we ban Alice",
  forum_id: loungeForum.id,
});
const hiddenTopic = topicFixture({
  id: 124,
  title: "Spam for Bob",
  forum_id: publicForum.id,
  is_hidden: true,
});
const visibleTopic = topicFixture({
  id: 125,
  title: "A visible roleplay",
  forum_id: publicForum.id,
});
const topics = [loungeTopic, hiddenTopic, visibleTopic];

// Fresh copies, because the presenters mutate what the loaders return.
function modsFor(sql: string, forumId: number) {
  if (!/FROM forum_mods\b/.test(sql)) return {};
  return {
    mods: (forumModsByForumId[forumId] ?? []).map((m) => ({ ...m })),
  };
}

function answer(sql: string, params: unknown[] = []) {
  const byTopicId = /FROM topics t\b[\s\S]*WHERE t\.id = \$(\d+)/.exec(sql);
  if (byTopicId) {
    const id = params[Number(byTopicId[1]) - 1];
    const topic = topics.find((t) => t.id === id);
    if (!topic) return { rows: [] };
    const forum = forums.find((f) => f.id === topic.forum_id)!;
    return {
      rows: [
        {
          ...topic,
          co_gm_ids: [...topic.co_gm_ids],
          forum: { ...forum },
          ...modsFor(sql, forum.id),
        },
      ],
    };
  }
  const byForumId = /FROM forums f\b[\s\S]*WHERE f\.id = \$(\d+)/.exec(sql);
  if (byForumId) {
    const id = params[Number(byForumId[1]) - 1];
    const forum = forums.find((f) => f.id === id);
    if (!forum) return { rows: [] };
    return { rows: [{ ...forum, ...modsFor(sql, forum.id) }] };
  }
  throw new Error(`unexpected query: ${sql}`);
}

beforeEach(() => {
  vi.mocked(pool.query).mockReset();
  vi.mocked(pool.query).mockImplementation((async (
    sql: string,
    params?: unknown[],
  ) => answer(sql, params)) as any);
});

////////////////////////////////////////////////////////////

const topicShapes: TopicShape[] = ["plain", "full", "with-subscription"];
const forumShapes: ForumShape[] = ["plain", "with-family"];

// with-subscription loads the viewer's own columns, so a guest uses full, the
// way the topic routes choose.
function shapeFor(viewer: object | null, shape: TopicShape): TopicShape {
  return viewer === null && shape === "with-subscription" ? "full" : shape;
}

function kindOf(load: TopicLoad | { kind: string }) {
  return load.kind;
}

describe("loadTopicFor", () => {
  // [viewer, lounge topic, hidden topic, visible topic]
  const table: [string, object | null, string, string, string][] = [
    ["guest", guest, "absent", "hidden", "readable"],
    ["member", member, "absent", "hidden", "readable"],
    ["forum mod", forumMod, "absent", "readable", "readable"],
    ["GM", gm, "absent", "hidden", "readable"],
    ["conmod", conmod, "readable", "hidden", "readable"],
    ["arenamod", arenamod, "readable", "hidden", "readable"],
    ["pwmod", pwmod, "absent", "hidden", "readable"],
    ["mod", mod, "readable", "readable", "readable"],
    ["smod", smod, "readable", "readable", "readable"],
    ["admin", admin, "readable", "readable", "readable"],
  ];

  describe.each(topicShapes)("with the %s shape", (shape) => {
    it.each(table)(
      "answers READ_TOPIC for a %s",
      async (_label, viewer, lounge, hidden, visible) => {
        const load = (id: number) =>
          loadTopicFor(viewer, id, shapeFor(viewer, shape)).then(kindOf);

        expect([
          await load(loungeTopic.id),
          await load(hiddenTopic.id),
          await load(visibleTopic.id),
        ]).toEqual([lounge, hidden, visible]);
      },
    );
  });

  it("returns only the forum id for a hidden topic the viewer cannot read", async () => {
    await expect(loadTopicFor(member, hiddenTopic.id, "full")).resolves.toEqual(
      { kind: "hidden", forumId: publicForum.id },
    );
  });

  it("returns the topic presented, with its forum's mods", async () => {
    const load = await loadTopicFor(member, visibleTopic.id, "full");

    expect(load.kind).toBe("readable");
    if (load.kind !== "readable") return;
    expect(load.topic.url).toBe("/topics/125-a-visible-roleplay");
    expect(load.topic.mods).toEqual([
      { id: forumMod.id, uname: forumMod.uname, slug: "forum-mod" },
    ]);
  });

  it("is absent for a missing id", async () => {
    for (const viewer of [guest, admin]) {
      await expect(loadTopicFor(viewer, 999, "full")).resolves.toEqual({
        kind: "absent",
      });
    }
  });
});

describe("loadForumFor", () => {
  // [viewer, lounge forum, public forum]
  const table: [string, object | null, string, string][] = [
    ["guest", guest, "absent", "readable"],
    ["member", member, "absent", "readable"],
    ["forum mod", forumMod, "absent", "readable"],
    ["conmod", conmod, "readable", "readable"],
    ["arenamod", arenamod, "readable", "readable"],
    ["pwmod", pwmod, "absent", "readable"],
    ["mod", mod, "readable", "readable"],
    ["smod", smod, "readable", "readable"],
    ["admin", admin, "readable", "readable"],
  ];

  describe.each(forumShapes)("with the %s shape", (shape) => {
    it.each(table)(
      "answers READ_FORUM for a %s",
      async (_label, viewer, lounge, open) => {
        const load = (id: number) =>
          loadForumFor(viewer, id, shape).then(kindOf);

        expect([
          await load(loungeForum.id),
          await load(publicForum.id),
        ]).toEqual([lounge, open]);
      },
    );

    it("returns the forum presented, with its mods", async () => {
      const load = await loadForumFor(guest, publicForum.id, shape);

      expect(load.kind).toBe("readable");
      if (load.kind !== "readable") return;
      expect(load.forum.url).toBe("/forums/3-free-roleplay");
      expect(load.forum.mods).toMatchObject([
        { id: forumMod.id, url: "/users/forum-mod" },
      ]);
    });
  });

  it("is absent for a missing id", async () => {
    for (const viewer of [guest, admin]) {
      await expect(loadForumFor(viewer, 999, "plain")).resolves.toEqual({
        kind: "absent",
      });
    }
  });
});
