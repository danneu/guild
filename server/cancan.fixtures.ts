// Rows shaped like the loaders' rows, and the viewers who ask about them, for
// tests that sweep cancan rules across every viewer. Test-only.

// The viewers each sweep asks about. The forum mod, GM, co-GM and post
// author are plain members; only the rows below give them their part.
export const actors = {
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
export type ActorName = keyof typeof actors;
export const actorNames = Object.keys(actors) as ActorName[];

// A forums row (f.*). Forum 4 is Casual Roleplay in category 2, so a rule
// that compares a forum id to the lounge category id shows up.
export function forumColumns(props: Record<string, unknown> = {}) {
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

export const plainForumColumns = forumColumns();

// loadTopicFor's plain shape (server/db/readable.ts#findTopic): t.*, the
// forum, the forum's mods, and the topic's banned_ids
export function topicRow(props: Record<string, unknown> = {}) {
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

// What Postgres's to_json makes of a row: dates become strings
export function asJson<T>(row: T): unknown {
  return JSON.parse(JSON.stringify(row));
}

// db.findPostById rows: p.*, the topic as to_jsonb(t.*) with its banned_ids
// (no forum or mods), and the forum. The member wrote every post but the
// zeroth one, which belongs to the GM.
export function postRow(
  topic: ReturnType<typeof topicRow>,
  props: Record<string, unknown> = {},
) {
  const { forum, mods: _mods, ...topicColumns } = topic;
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
    topic: asJson(topicColumns),
    forum,
    ...props,
  };
}
