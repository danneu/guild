// 3rd party
import createDebug from "debug";
const debug = createDebug("app:cancan");
import assert from "node:assert";
import { z } from "zod";
// 1st
import * as config from "./config";

// These are forums where topics cannot be posted
// in if the latest post is older than 1 month
const ANTI_NECRO_FORUMS = [
  30, // Spam
  32, // Member Lounge
  33, // Off-topic
  9, // Bugs/feature requests
  36, // Need help?
  1, // News
  2, // Introduce yourself
];

const CONTEST_FORUMS = [45, 44];
const ARENA_FORUMS = [6, 15];
// Forums that pwmods have mod-privs in
const PW_FORUMS = [49, 50, 51];

// The Lexus Lounge (mod forum) category. Rules test it only through
// isModForum (or READ_CATEGORY for a category row), so no rule names the id.
// SQL read scopes compare it directly, since SQL cannot call isModForum.
export const MOD_CATEGORY_ID = 4;

// The values of the role_type enum in sql/1-schema.sql. can() refuses an actor
// or a target user whose role is not one of them.
export const ROLES = [
  "admin",
  "smod",
  "mod",
  "member",
  "banned",
  "conmod",
  "arenamod",
  "pwmod",
] as const;
export type Role = (typeof ROLES)[number];

////////////////////////////////////////////////////////////
// Targets
//
// Each action declares the target it reads as a zod schema. can() checks the
// actor and the target against them before any rule runs, so a row that lacks
// a field throws instead of reading as undefined, which used to allow. The
// rules' parameter types come from the same schemas, so a rule that reads an
// undeclared field fails `pnpm run check`. A schema lists only what its rule
// and the rules it asks read, so a loader selects no column a page never needs.
//
// Schemas are plain z.object, with no passthrough or catchall: those add an
// index signature, and an undeclared read would then compile as unknown. They
// have no transforms either, so a schema's input and output types match.

const int = z.number().int();
const role = z.enum(ROLES);

// Who asks. Guests reach can() as undefined (server/middleware#currUser leaves
// ctx.currUser unset) or as null.
const ACTOR = z.object({ id: int, role }).nullish();
export type Actor = z.infer<typeof ACTOR>;

// The forum's mods, as the forum_mods fragment in server/db/readable.ts selects
const forumMods = z.array(z.object({ id: int }));
const user = z.object({ id: int, role });
const userId = z.object({ id: int });
const userRole = z.object({ role });
const participants = z.object({ participants: z.array(userId) });
const ownedRow = z.object({ user_id: int });
// What isModForum reads
const forumCategory = z.object({ category_id: int });

// What READ_TOPIC reads, so every action it gates reads it too
const readableTopic = z.object({
  forum_id: int,
  is_hidden: z.boolean(),
  forum: forumCategory,
  mods: forumMods,
});
// What isTopicGm reads
const gmFields = { user_id: int, co_gm_ids: z.array(int) };
const taggedForum = z.object({
  category_id: int,
  has_tags_enabled: z.boolean(),
});

// What READ_POST reads: the post, its topic and the topic's forum
const postTopic = z.object({
  forum_id: int,
  is_hidden: z.boolean(),
  ...gmFields,
});
const readablePost = z.object({
  is_hidden: z.boolean(),
  forum: forumCategory,
  topic: postTopic,
});
const zerothPost = readablePost.extend({ idx: int.nullable() });

const TARGETS = {
  // Topic Management
  ACCESS_TOPIC_MODKIT: z.object({ forum_id: int, mods: forumMods }),
  // UPDATE_TOPIC also asks the three rules below it
  UPDATE_TOPIC: readableTopic.extend({
    ...gmFields,
    is_closed: z.boolean(),
    is_roleplay: z.boolean(),
    forum: taggedForum,
  }),
  UPDATE_TOPIC_JOIN_STATUS: readableTopic.extend({
    ...gmFields,
    is_roleplay: z.boolean(),
  }),
  UPDATE_TOPIC_TAGS: readableTopic.extend({ ...gmFields, forum: taggedForum }),
  UPDATE_TOPIC_CO_GMS: readableTopic.extend({
    user_id: int,
    is_roleplay: z.boolean(),
  }),
  UPDATE_TOPIC_TITLE: readableTopic.extend(gmFields),
  // A forum
  CREATE_TOPIC: forumCategory,
  READ_TOPIC: readableTopic,
  MOVE_TOPIC: readableTopic,
  STICK_TOPIC: readableTopic,
  UNSTICK_TOPIC: readableTopic,
  HIDE_TOPIC: readableTopic,
  UNHIDE_TOPIC: readableTopic,
  CLOSE_TOPIC: readableTopic,
  OPEN_TOPIC: readableTopic,
  SUBSCRIBE_TOPIC: readableTopic,
  UNSUBSCRIBE_TOPIC: z.unknown(),
  TOPIC_BAN: z.object({ topic: z.object(gmFields), user }),

  // Post Management
  // A topic. banned_ids is not a topics column: only the loaders that select
  // it from topic_bans carry it (server/db/readable.ts#BANNED_IDS_JSON).
  CREATE_POST: readableTopic.extend({
    is_closed: z.boolean(),
    latest_post_at: z.date().nullable(),
    banned_ids: z.array(int),
  }),
  READ_POST: readablePost,
  // The ban list sits on post.topic, because a ban is a topic fact
  UPDATE_POST: zerothPost.extend({
    id: int,
    user_id: int,
    topic: postTopic.extend({ banned_ids: z.array(int) }),
  }),
  HIDE_POST: zerothPost,
  UNHIDE_POST: zerothPost,
  RATE_POST: readablePost.extend({ user_id: int }),

  // User Management
  UPDATE_USER: user,
  UPDATE_USER_ROLE: userRole,
  GRANT_EMAIL_GATE_EXEMPTION: userRole,
  UPDATE_USER_CUSTOM_TITLE: user,
  DELETE_USER: z.unknown(),
  READ_USER_ONLINE_STATUS: z.object({ id: int, is_ghost: z.boolean() }),
  READ_USER_PM_SENT_COUNT: z.unknown(),
  READ_USER_RATINGS_TABLE: userId,
  READ_USER_IP: userRole,
  READ_USER_LIST: z.unknown(),
  NUKE_USER: userRole,
  CHANGE_UNAME: user,

  // Status Management
  CREATE_USER_STATUS: userId,
  DELETE_USER_STATUS: ownedRow,
  MANAGE_USER_STATUS: userId,
  LIKE_STATUS: z.object({ user_id: int, liked_user_ids: z.array(int) }),

  // Trophy System
  MANAGE_TROPHY_SYSTEM: z.unknown(),
  UPDATE_TROPHY: z.unknown(),
  CREATE_TROPHY_GROUP: z.unknown(),
  UPDATE_TROPHY_GROUP: z.unknown(),

  // Private Messages & Conversations
  CREATE_CONVO: z.unknown(),
  READ_CONVO: participants,
  DELETE_CONVO: participants,
  CREATE_PM: participants,
  READ_PM: participants,
  UPDATE_PM: z.object({ user_id: int, legacy_html: z.string().nullable() }),

  // Visitor Messages
  CREATE_VM: z.unknown(),
  DELETE_VM: z.object({
    from_user_id: int,
    to_user_id: int,
    from_user: userRole,
  }),

  // Forums & Categories
  READ_FORUM: forumCategory,
  READ_CATEGORY: userId,
  LEXUS_LOUNGE: z.unknown(),

  // Notifications
  DELETE_NOTIFICATION: z.object({ to_user_id: int }),

  // Images
  MANAGE_IMAGES: user,
  UPLOAD_IMAGE: userId,

  // Dice/Campaign System
  CREATE_CAMPAIGN: z.unknown(),
  READ_CAMPAIGN: z.unknown(),
  UPDATE_CAMPAIGN: ownedRow,
  CREATE_ROLL: ownedRow,

  // Chat
  READ_CHATLOGS: z.unknown(),
} satisfies Record<CanAction, z.ZodTypeAny>;

export type Target<A extends CanAction> = z.infer<(typeof TARGETS)[A]>;

// An action whose rule reads no target field takes any target, or none.
type TargetArgs<A extends CanAction> =
  unknown extends Target<A> ? [target?: Target<A>] : [target: Target<A>];

// Throws when `value` does not match `schema`. The message names each field
// that failed, so a 500 says which loader column is missing.
function check(schema: z.ZodTypeAny, value: unknown, what: string) {
  const result = schema.safeParse(value);
  if (result.success) return;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`cancan: ${what} does not match its schema (${issues})`);
}

////////////////////////////////////////////////////////////

// The one lounge test for a forum row. server/readable.ts calls it directly,
// outside can(), so it checks the field it reads itself: a short or wrong row
// (say, a topic passed where its forum belongs) throws instead of reading as
// "not lounge", which would allow.
export function isModForum(forum: z.infer<typeof forumCategory>): boolean {
  check(forumCategory, forum, "isModForum: the forum");
  return forum.category_id === MOD_CATEGORY_ID;
}

// The one list of roles that may read the lounge forums, their topics and
// their category. READ_POST asks LEXUS_LOUNGE instead, a narrower set that
// keeps conmods and arenamods out of lounge posts; which set is right is an
// open question.
export function mayEnterModForums(user: Actor): boolean {
  if (!user) return false;
  return ["conmod", "arenamod", "mod", "smod", "admin"].includes(user.role);
}

// Applies to anyone above member
//
// TODO: Now that I've added the 'conmod' role, this function doesn't make
// much sense since many times I use this function (like to restrict LexusLounge
// access) I don't want to include conmods. But I would still consider them staff.
// I think I should replace this function with explicitly inlining the
// [x, y, z].includes(role) call and removing this function.
export const isStaffRole = function isStaffRole(role: string) {
  return ["mod", "smod", "admin"].includes(role);
};

// views/show_topic.html calls this directly, outside can(), so it checks the
// fields it reads itself.
export function isTopicGm(
  user: Actor,
  topic: { user_id: number; co_gm_ids: number[] },
): boolean {
  assert(topic);
  assert(Array.isArray(topic.co_gm_ids));
  if (!user) return false;
  if (user.id === topic.user_id) return true;
  if (topic.co_gm_ids.some((id) => id === user.id)) return true;
  return false;
}

// The read rule each action also requires. can() asks it before the action's
// own rule, so writes never restate the lounge and hidden rules that
// READ_FORUM, READ_TOPIC and READ_POST own. The Record type makes every new
// action declare its gate; null means the action has none.
const READ_GATE = {
  // Topic Management
  ACCESS_TOPIC_MODKIT: null,
  UPDATE_TOPIC: "READ_TOPIC",
  UPDATE_TOPIC_JOIN_STATUS: "READ_TOPIC",
  UPDATE_TOPIC_TAGS: "READ_TOPIC",
  UPDATE_TOPIC_CO_GMS: "READ_TOPIC",
  UPDATE_TOPIC_TITLE: "READ_TOPIC",
  CREATE_TOPIC: "READ_FORUM",
  READ_TOPIC: null,
  MOVE_TOPIC: "READ_TOPIC",
  STICK_TOPIC: "READ_TOPIC",
  UNSTICK_TOPIC: "READ_TOPIC",
  HIDE_TOPIC: "READ_TOPIC",
  UNHIDE_TOPIC: "READ_TOPIC",
  CLOSE_TOPIC: "READ_TOPIC",
  OPEN_TOPIC: "READ_TOPIC",
  SUBSCRIBE_TOPIC: "READ_TOPIC",
  // A user must be able to leave a topic after losing read access to it.
  UNSUBSCRIBE_TOPIC: null,
  // Known gap: the target is { topic, user }, which READ_TOPIC cannot take.
  TOPIC_BAN: null,

  // Post Management
  CREATE_POST: "READ_TOPIC",
  READ_POST: null,
  UPDATE_POST: "READ_POST",
  HIDE_POST: "READ_POST",
  UNHIDE_POST: "READ_POST",
  RATE_POST: "READ_POST",

  // User Management
  UPDATE_USER: null,
  UPDATE_USER_ROLE: null,
  GRANT_EMAIL_GATE_EXEMPTION: null,
  UPDATE_USER_CUSTOM_TITLE: null,
  DELETE_USER: null,
  READ_USER_ONLINE_STATUS: null,
  READ_USER_PM_SENT_COUNT: null,
  READ_USER_RATINGS_TABLE: null,
  READ_USER_IP: null,
  READ_USER_LIST: null,
  NUKE_USER: null,
  CHANGE_UNAME: null,

  // Status Management
  CREATE_USER_STATUS: null,
  DELETE_USER_STATUS: null,
  MANAGE_USER_STATUS: null,
  LIKE_STATUS: null,

  // Trophy System
  MANAGE_TROPHY_SYSTEM: null,
  UPDATE_TROPHY: null,
  CREATE_TROPHY_GROUP: null,
  UPDATE_TROPHY_GROUP: null,

  // Private Messages & Conversations
  CREATE_CONVO: null,
  READ_CONVO: null,
  DELETE_CONVO: null,
  CREATE_PM: null,
  READ_PM: null,
  UPDATE_PM: null,

  // Visitor Messages
  CREATE_VM: null,
  DELETE_VM: null,

  // Forums & Categories
  READ_FORUM: null,
  READ_CATEGORY: null,
  LEXUS_LOUNGE: null,

  // Notifications
  DELETE_NOTIFICATION: null,

  // Images
  MANAGE_IMAGES: null,
  UPLOAD_IMAGE: null,

  // Dice/Campaign System
  CREATE_CAMPAIGN: null,
  READ_CAMPAIGN: null,
  UPDATE_CAMPAIGN: null,
  CREATE_ROLL: null,

  // Chat
  READ_CHATLOGS: null,
} as const satisfies Record<CanAction, CanAction | null>;

// Each action whose target lacks a field its read gate reads. can() hands the
// gate the action's own target, so that gate would throw on every call.
type GateMisfit = {
  [A in CanAction]: (typeof READ_GATE)[A] extends infer G extends CanAction
    ? Target<A> extends Target<G>
      ? never
      : A
    : never;
}[CanAction];
type NoMisfit<T extends never> = T;
// Fails `pnpm run check`, naming the action, while any gate misfits.
export type ReadGateFits = NoMisfit<GateMisfit>;

// Answers whether `user` may do `action` to `target`. Throws when the actor or
// the target does not match its schema, which fails closed. Rules get the
// objects the caller passed, never zod's stripped copies, so a rule and the
// view that renders the same row see the same fields.
export function can<A extends CanAction>(
  user: Actor,
  action: A,
  ...args: TargetArgs<A>
): boolean {
  const target: unknown = args[0];
  check(ACTOR, user, `${action}: the actor`);
  check(TARGETS[action], target, `${action}: the target`);
  const gate = READ_GATE[action];
  const result =
    gate !== null && !can<CanAction>(user, gate, target)
      ? false
      : RULES[action](user, target as Target<A>);
  debug(
    "%s %s %s",
    user ? `user ${user.id}` : "guest",
    result ? "can" : "cannot",
    action,
  );
  return result;
}

export function cannot<A extends CanAction>(
  user: Actor,
  action: A,
  ...args: TargetArgs<A>
): boolean {
  return !can(user, action, ...args);
}

////////////////////////////////////////////////////////////
// Rules
//
// A banned user's writes stop at
// server/middleware/require-not-banned.ts#requireNotBanned before any route
// asks. In a write rule below, a `user.role === "banned"` line is a UI hint: it
// hides a control that gate would refuse.

type Rules = { [A in CanAction]: (user: Actor, target: Target<A>) => boolean };

// Shared by the trophy actions
function manageTrophies(user: Actor): boolean {
  // Guests can't
  if (!user) return false;
  // Conmods can
  if (user.role === "conmod") return true;
  // Admin can
  if (user.role === "admin") return true;
  return false;
}

// Shared by the stick, hide and close topic actions and their undos
function manageTopicStatus(
  user: Actor,
  target: Target<"STICK_TOPIC">,
): boolean {
  // Guests cannot
  if (!user) return false;
  // Banned cannot
  if (user.role === "banned") return false;
  // Staff can do this
  if (isStaffRole(user.role)) return true;
  // Conmods can manage topics in contest forums
  if (user.role === "conmod" && CONTEST_FORUMS.includes(target.forum_id))
    return true;
  // Arena mod can in arena forums
  if (user.role === "arenamod" && ARENA_FORUMS.includes(target.forum_id))
    return true;
  if (user.role === "pwmod" && PW_FORUMS.includes(target.forum_id)) return true;
  // Can if they are forum mod
  if (target.mods.some((m) => m.id === user.id)) {
    return true;
  }
  return false;
}

// Shared by DELETE_CONVO and READ_CONVO
function readConvo(user: Actor, target: Target<"READ_CONVO">): boolean {
  // Banned members can't
  if (!user) return false;
  // Admin can read all convos
  if (user.role === "admin") return true;
  // Users can only read convos they're participants of
  if (target.participants.some((x) => x.id === user.id)) return true;
  return false;
}

const RULES: Rules = {
  ACCESS_TOPIC_MODKIT(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    if (["mod", "smod", "admin"].includes(user.role)) return true;
    if (user.role === "conmod" && CONTEST_FORUMS.includes(target.forum_id)) {
      return true;
    }
    if (user.role === "arenamod" && ARENA_FORUMS.includes(target.forum_id)) {
      return true;
    }
    if (user.role === "pwmod" && PW_FORUMS.includes(target.forum_id)) {
      return true;
    }
    // Can if they are forum mod
    if (target.mods.some((m) => m.id === user.id)) {
      return true;
    }
    return false;
  },
  // no target, intended to wrap all privs
  MANAGE_TROPHY_SYSTEM: manageTrophies,
  UPDATE_TROPHY: manageTrophies,
  CREATE_TROPHY_GROUP: manageTrophies,
  UPDATE_TROPHY_GROUP: manageTrophies,
  DELETE_NOTIFICATION(user, target) {
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // User can if it's their notification
    if (user.id === target.to_user_id) return true;
    return false;
  },
  // TODO: Replace this with MANAGE_USER_STATUS
  DELETE_USER_STATUS(user, target) {
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // User can delete their own statuses
    if (user.id === target.user_id) return true;
    // Staff can
    if (isStaffRole(user.role)) return true;
    return false;
  },
  // target is user
  MANAGE_USER_STATUS(user, target) {
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // User can delete their own statuses
    if (user.id === target.id) return true;
    // Staff can
    if (isStaffRole(user.role)) return true;
    return false;
  },
  LIKE_STATUS(user, target) {
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // Users can't like if its their own status
    if (user.id === target.user_id) return false;
    // Users can like it if they haven't already liked it
    if (!target.liked_user_ids.includes(user.id)) return true;
    return false;
  },
  // target is user
  CREATE_USER_STATUS(user, target) {
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // User can update themself
    if (user.id === target.id) return true;
    return false;
  },
  // Expresses user's ability to update any part of a topic
  // Only use this for high level checks like to see if a user
  // should see the "Edit Topic" link at all. The actual actions they
  // can do to a topic will vary.
  // Use the specific checks for granular authorization.
  UPDATE_TOPIC(user, target) {
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // Staff can
    if (isStaffRole(user.role)) return true;
    // Conmod can if it's in contest forums
    if (user.role === "conmod" && CONTEST_FORUMS.includes(target.forum_id))
      return true;
    // Arena Mod can // TODO: if it's in ArenaRP forum
    if (ARENA_FORUMS.includes(target.forum_id) && user.role === "arenamod")
      return true;
    if (PW_FORUMS.includes(target.forum_id) && user.role === "pwmod")
      return true;
    // If non-staff, then cannot if topic is hidden/closed
    if (target.is_closed || target.is_hidden) return false;
    // GMs can
    if (isTopicGm(user, target)) {
      return true;
    }
    // FIXME: (Sloppy) Check if user is eligible for any of the types of edits
    return (
      can(user, "UPDATE_TOPIC_JOIN_STATUS", target) ||
      can(user, "UPDATE_TOPIC_TAGS", target) ||
      can(user, "UPDATE_TOPIC_CO_GMS", target)
    );
  },
  UPDATE_TOPIC_JOIN_STATUS(user, target) {
    // Nobody can unless it's a roleplay
    if (!target.is_roleplay) return false;
    // Guests cant
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // Topic creator can
    if (user.id === target.user_id) return true;
    // co-GMs can
    if (target.co_gm_ids.includes(user.id)) return true;
    // Staff can
    if (isStaffRole(user.role)) return true;
    return false;
  },
  UPDATE_TOPIC_TAGS(user, target) {
    // Nobody can unless forum has tags enabled
    if (!target.forum.has_tags_enabled) return false;
    // Guests never can
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // GM can
    if (target.user_id === user.id) return true;
    // Co-GMs can
    if (target.co_gm_ids.includes(user.id)) return true;
    // Staff can
    if (isStaffRole(user.role)) return true;
    return false;
  },
  UPDATE_TOPIC_CO_GMS(user, target) {
    // Only roleplays can have co-GMs
    if (!target.is_roleplay) return false;
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // GM can
    if (target.user_id === user.id) return true;
    // Staff can
    if (isStaffRole(user.role)) return true;
    return false;
  },
  // target is user
  UPDATE_USER_CUSTOM_TITLE(user, target) {
    // Never more than profile edit, so the title route grants no power over
    // a profile whose edit page the user cannot open. Guests and banned
    // users stop here.
    if (!can(user, "UPDATE_USER", target)) return false;
    if (!user) return false;
    // Members and Conmods can only change their own
    if (["member", "conmod"].includes(user.role)) return user.id === target.id;
    // Mods can change their own title and the title of any non-staff
    if (user.role === "mod")
      return user.id === target.id || !isStaffRole(target.role);
    // Smods can change mods and below
    if (user.role === "smod")
      return (
        user.id === target.id ||
        target.role === "mod" ||
        !isStaffRole(target.role)
      );
    // Admins can change all
    if (user.role === "admin") return true;
    return false;
  },
  // The ratings table is on the user profile
  READ_USER_RATINGS_TABLE(user, target) {
    // Guests cannot
    if (!user) return false;
    // Banned cannot
    if (user.role === "banned") return false;
    // Staff can read everyone's
    if (isStaffRole(user.role)) return true;
    // everyone can read their own
    return user.id === target.id;
  },
  RATE_POST(user, target) {
    // Guests can't rate
    if (!user) return false;
    // Banned members can't rate
    if (user.role === "banned") return false;
    // Cannot rate your own post
    if (user.id === target.user_id) return false;
    // Everyone else can if READ_GATE lets them read the post
    return true;
  },
  READ_USER_LIST() {
    // Let guests read this for now
    return true;
    //
    // Only registered users can
    // if (!user) return false;
    // return true;
  },
  UPDATE_TOPIC_TITLE(user, target) {
    if (!user) return false;
    // Banned users can't update their old topics
    if (user.role === "banned") return false;
    // Staff can edit all topic titles
    if (isStaffRole(user.role)) return true;
    // Topic owner/GM can edit their own titles
    if (user.id === target.user_id) return true;
    // Co-GMs can also edit topic title
    if (target.co_gm_ids.includes(user.id)) return true;
    // Conmods can edit any topic in contest forums
    if (user.role === "conmod" && CONTEST_FORUMS.includes(target.forum_id))
      return true;
    // Arena mods can edit topic titles in arena forum
    if (user.role === "arenamod" && ARENA_FORUMS.includes(target.forum_id))
      return true;
    if (user.role === "pwmod" && PW_FORUMS.includes(target.forum_id))
      return true;
    return false;
  },
  READ_USER_ONLINE_STATUS(user, target) {
    // Guests and members can see status if target isn't in invisible mode.
    if (!user) return !target.is_ghost;
    // Members & conmods can see themselves regardless of ghost status
    if (["member", "conmod"].includes(user.role))
      return target.id === user.id || !target.is_ghost;
    // Staff can see ghosts
    if (isStaffRole(user.role)) return true;
    return false;
  },
  // target is user
  DELETE_USER(user) {
    if (!user) return false;
    return user.role === "admin";
  },
  // target is user
  READ_USER_PM_SENT_COUNT(user) {
    // Guests cannot
    if (!user) return false;
    // Only staff can read user pm-sent count
    if (isStaffRole(user.role)) return true;
    return false;
  },
  UPDATE_USER_ROLE(user, target) {
    if (!user) return false;
    if (user.role === "admin") return true;
    // smods can change everyone except admin
    if (user.role === "smod") return target.role !== "admin";
    // mods can change non-staff and pw-mods
    if (user.role === "mod")
      return ["banned", "member", "pwmod"].includes(target.role);
    return false;
  },
  GRANT_EMAIL_GATE_EXEMPTION(user, target) {
    // Mirrors UPDATE_USER_ROLE: during a mail-delivery incident the thing
    // staff need is "let this person post". Note this excuses the account
    // from the write gate; it never claims the address was confirmed
    // (plan/2026-08-11-1613).
    if (!user) return false;
    if (user.role === "admin") return true;
    if (user.role === "smod") return target.role !== "admin";
    if (user.role === "mod")
      return ["banned", "member", "pwmod"].includes(target.role);
    return false;
  },
  UPDATE_USER(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // Anyone can update themselves
    if (user.id === target.id) return true;
    // Staff can change staff below them
    if (user.role === "admin") return true;
    if (user.role === "smod") return target.role !== "admin";
    if (user.role === "mod")
      return ["banned", "member", "pwmod"].includes(target.role);
    return false;
  },
  // Post state -- target is post
  UNHIDE_POST(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // Staff can unhide
    if (isStaffRole(user.role)) return true;
    if (user.role === "conmod") return true;
    if (user.role === "arenamod") return true;
    // GMs can unhide zeroth post
    if (target.idx === -1 && isTopicGm(user, target.topic)) {
      return true;
    }
    return false;
  },
  HIDE_POST(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // Cannot hide a post if it is the last post in this topic/RP
    //if (target.topic && target.topic.posts_count === 1) {
    //  return false
    //}
    // Staff can hide
    if (isStaffRole(user.role)) return true;
    // TODO: Only let boutique mods hide posts in their respective forums.
    if (user.role === "conmod") return true;
    if (user.role === "arenamod") return true;
    if (user.role === "pwmod") return true;
    // GMs can hide zeroth post
    if (target.idx === -1 && isTopicGm(user, target.topic)) {
      return true;
    }
    // Users can hide their own post if the post within 1 hour
    // Caution: remember to handle the case where this is the last unhidden
    // post in a topic.
    // TEMP: Turned this off while I figure out some issues
    /* if (user.id === target.user_id && belt.isNewerThan(target.created_at, { hours: 1 })) {
     *   return true
     * }*/
    return false;
  },
  // Topic state
  MOVE_TOPIC(user) {
    if (!user) return false;
    if (isStaffRole(user.role)) return true;
    return false;
  },
  STICK_TOPIC: manageTopicStatus,
  UNSTICK_TOPIC: manageTopicStatus,
  HIDE_TOPIC: manageTopicStatus,
  UNHIDE_TOPIC: manageTopicStatus,
  CLOSE_TOPIC: manageTopicStatus,
  OPEN_TOPIC: manageTopicStatus,
  CREATE_POST(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // Staff can always create posts anywhere
    if (isStaffRole(user.role)) return true;
    // Can if they are forum mod
    if (target.mods.some((m) => m.id === user.id)) {
      return true;
    }
    // TODO: Limit boutique mods to respective forums.
    if (user.role === "conmod") {
      return true;
    }
    if (user.role === "arenamod") {
      return true;
    }
    if (user.role === "pwmod") {
      return true;
    }
    // Members can post as long as the topic is open and they are not on
    // the topic's banlist. READ_GATE keeps them out of hidden and lounge
    // topics.
    if (user.role === "member") {
      if (target.is_closed) return false;
      if (target.banned_ids.includes(user.id)) return false;

      // Topic latest_post_at must be newer than 1 month
      // if in certain forums where necro'ing is disruptive
      if (ANTI_NECRO_FORUMS.includes(target.forum_id)) {
        var t = new Date();
        t.setMonth(t.getMonth() - 1);
        return target.latest_post_at !== null && target.latest_post_at > t;
      }
      return true;
    }
    return false;
  },
  // target is pm with pm.convo and pm.participants props
  READ_PM(user, target) {
    // Guests can't
    if (!user) return false;
    // Admin can see all
    if (user.role === "admin") return true;
    return target.participants.some((p) => p.id === user.id);
  },
  // target is post with a post.topic prop
  READ_POST(user, target) {
    if (isModForum(target.forum)) {
      return can(user, "LEXUS_LOUNGE");
    }
    // Staff can read all posts
    if (user && isStaffRole(user.role)) return true;
    // conmods can read all posts in contest forums
    if (
      user &&
      user.role === "conmod" &&
      CONTEST_FORUMS.includes(target.topic.forum_id)
    ) {
      return true;
    }
    // arnamods can read all posts in arena forums
    if (
      user &&
      user.role === "arenamod" &&
      ARENA_FORUMS.includes(target.topic.forum_id)
    ) {
      return true;
    }
    // pwmods can read all posts in pw forums
    if (
      user &&
      user.role === "pwmod" &&
      PW_FORUMS.includes(target.topic.forum_id)
    ) {
      return true;
    }
    // GMs and co-GMs can read every post in their topic, even hidden ones
    if (isTopicGm(user, target.topic)) {
      return true;
    }

    // Everyone else can read a post as long as it's not hidden
    // and the topic is not hidden
    return !target.is_hidden && !target.topic.is_hidden;
  },
  READ_USER_IP(user, target) {
    if (!user) return false;
    // Staff can only see down-chain
    if (user.role === "admin") return true;
    if (user.role === "smod")
      return ["mod", "member", "banned"].includes(target.role);
    if (user.role === "mod") return ["member", "banned"].includes(target.role);
    return false;
  },
  READ_FORUM(user, target) {
    if (isModForum(target)) return mayEnterModForums(user);
    else return true; // for now, anyone can read a non-lexus-lounge forum
    // TODO: Forum mods should be able to read their own forum,
    // maybe it canbe hidden from others? Unlisted while they work?
  },
  LEXUS_LOUNGE(user) {
    if (!user) return false;
    // All staff can access
    if (["conmod", "arenamod"].includes(user.role)) return false;
    // conmods and arenamods can't
    if (isStaffRole(user.role)) return true;
    return false;
  },
  // TODO: Replace LEXUS_LOUNGE with this?
  READ_CATEGORY(user, target) {
    // Anyone can view any category except for lexus lounge
    if (target.id === MOD_CATEGORY_ID) return mayEnterModForums(user);
    else return true;
  },
  UNSUBSCRIBE_TOPIC(user) {
    // A user can unsubscribe from a topic if they're logged in
    return !!user;
  },
  SUBSCRIBE_TOPIC(user) {
    if (!user) return false;
    // banned cannot
    if (user.role === "banned") return false;
    // everyone else can if READ_GATE lets them read the topic
    return true;
  },
  // target is convo w/ participants prop
  CREATE_PM(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // User can send pm if they're a participant
    return target.participants.some((p) => p.id === user.id);
  },
  READ_TOPIC(user, target) {
    if (isModForum(target.forum)) return mayEnterModForums(user);
    // conmod can read any topic in contests forum
    if (
      user &&
      user.role === "conmod" &&
      CONTEST_FORUMS.includes(target.forum_id)
    )
      return true;
    // arenamod can read any topic in arena forums
    if (
      user &&
      user.role === "arenamod" &&
      ARENA_FORUMS.includes(target.forum_id)
    )
      return true;
    // pwmod can read any topic in pw forums
    if (user && user.role === "pwmod" && PW_FORUMS.includes(target.forum_id))
      return true;
    // Staff can always read hidden topics
    if (user && target.is_hidden && isStaffRole(user.role)) {
      return true;
    }
    // forum mods can read all tpics in their appointed forum
    if (user && target.mods.some((m) => m.id === user.id)) {
      return true;
    }
    if (!target.is_hidden) {
      return true;
    }
    return false;
  },
  CREATE_CONVO(user) {
    if (!user) return false;
    // Any user that isn't banned can start convo
    return user.role !== "banned";
  },
  // target is forum
  CREATE_TOPIC(user) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // READ_GATE keeps everyone who cannot read the forum out of it
    if (
      ["mod", "arenamod", "conmod", "pwmod", "smod", "admin"].includes(
        user.role,
      )
    )
      return true;
    if (user.role === "member") return true;
    return false;
  },
  // target is pm with pm.convo and pm.participants
  UPDATE_PM(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // Can't update legacy PMs. TODO: Implement BBCode editing for PMs
    // once post BBCode system is tested
    if (target.legacy_html) return false;
    // User can update a PM if they own it
    if (target.user_id === user.id) return true;
    return false;
  },
  UPDATE_POST(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // Admin can update any post
    if (user.role === "admin") return true;
    // GM and Co-GM can edit the 0th post
    if (target.idx === -1 && isTopicGm(user, target.topic)) {
      return true;
    }
    // Cannot update post if banned from topic
    if (target.topic.banned_ids.includes(user.id)) return false;
    // TODO: Create rules for other staff roles
    // User can edit their own post
    if (user.id === target.user_id) return true;
    // All Staff can edit a post if it's the FAQ_POST_ID
    if (target.id === config.FAQ_POST_ID && isStaffRole(user.role)) {
      return true;
    }
    // All Staff can edit a post if it's the WELCOME_POST_ID
    if (target.id === config.WELCOME_POST_ID && isStaffRole(user.role)) {
      return true;
    }
    // All staff can edit any post unless it's admin's post
    //if (isStaffRole(user.role) && target.user_id !== 1) {
    //  return true
    //}
    return false;
  },
  DELETE_CONVO: readConvo,
  READ_CONVO: readConvo,
  DELETE_VM(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // You can delete your own VM
    if (user.id === target.from_user_id) return true;
    // You can delete VMs on your wall unless it's from staff
    if (user.id === target.to_user_id && user.role === "member")
      return !isStaffRole(target.from_user.role);
    // Staff
    if (user.role === "admin") {
      return true;
    }
    if (user.role === "smod") {
      return target.from_user.role !== "admin";
    }
    if (user.role === "mod") {
      return !isStaffRole(target.from_user.role);
    }
    return false;
  },
  CREATE_VM(user) {
    // Guests can't
    if (!user) return false;
    // Banned can't
    if (user.role === "banned") return false;
    // Everyone else can
    return true;
  },
  // target is spambot user
  NUKE_USER(user, target) {
    // guests cannot
    if (!user) return false;
    // staff can ban non-staff
    if (isStaffRole(user.role) && !isStaffRole(target.role)) return true;
    return false;
  },
  // target is the user being managed
  MANAGE_IMAGES(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    if (user.id === target.id) return true;
    if (isStaffRole(user.role) && !isStaffRole(target.role)) return true;
    return false;
  },
  // target is user the image is uploaded to
  UPLOAD_IMAGE(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    if (user.id === target.id) return true;
    return false;
  },
  // target is user to have their uname changed
  CHANGE_UNAME(user, target) {
    // Guests cannot
    if (!user) return false;
    // Banned cannot
    if (user.role === "banned") return false;
    // Admin can change anyone's uname
    if (user.role === "admin") return true;
    // Staff can change their own name and the name of any non-staff
    if (isStaffRole(user.role)) {
      if (user.id === target.id) {
        return true;
      } else {
        return !isStaffRole(target.role);
      }
    }
    // Everyone else can only change their own username
    if (user.id === target.id) return true;
    return false;
  },
  //
  // DICE
  //
  // target is campaign
  UPDATE_CAMPAIGN(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // people can update their own campaigns
    if (user.id === target.user_id) return true;
    // staff can update any campaign
    if (isStaffRole(user.role)) return true;
    return false;
  },
  // target is campaign
  READ_CAMPAIGN() {
    // anyone can
    return true;
  },
  CREATE_CAMPAIGN(user) {
    if (!user) return false;
    // anyone that's not banned can
    if (user.role !== "banned") return true;
    return false;
  },
  // TODO: yes if they are coGM/GM of target.topic_id
  // target is campaign
  CREATE_ROLL(user, target) {
    if (!user) return false;
    if (user.role === "banned") return false;
    // can if they own the campaign
    if (user.id === target.user_id) return true;
    return false;
  },
  //
  // CHAT
  //
  READ_CHATLOGS(user) {
    if (!user) return false;
    if (user.id === 107) return true; // HACK: Let Ellri
    if (isStaffRole(user.role)) return true; // Only staff can
    return false;
  },
  //
  // GM/CO-GM
  //
  TOPIC_BAN(user, target) {
    if (!user) return false;
    // Staff cannot be banned
    if (isStaffRole(target.user.role)) return false;
    // GM cannot be banned
    if (target.user.id === target.topic.user_id) return false;
    // Co-GMs cannot be banned
    if (target.topic.co_gm_ids.includes(target.user.id)) return false;
    // Staff can ban
    if (isStaffRole(user.role)) return true;
    // GM can ban
    if (user.id === target.topic.user_id) return true;
    // Co-GMs can ban
    if (target.topic.co_gm_ids.includes(user.id)) return true;
    return false;
  },
};

export function visibleRegistrationIp(currUser: any, user: any): string | null {
  if (!user.registration_ip) return null;
  if (user.created_at < config.REGISTRATION_IP_MILESTONE) return null;
  if (!can(currUser, "READ_USER_IP", user)) return null;
  return user.registration_ip;
}

export const CanAction = {
  // Topic Management
  ACCESS_TOPIC_MODKIT: "ACCESS_TOPIC_MODKIT",
  UPDATE_TOPIC: "UPDATE_TOPIC",
  UPDATE_TOPIC_JOIN_STATUS: "UPDATE_TOPIC_JOIN_STATUS",
  UPDATE_TOPIC_TAGS: "UPDATE_TOPIC_TAGS",
  UPDATE_TOPIC_CO_GMS: "UPDATE_TOPIC_CO_GMS",
  UPDATE_TOPIC_TITLE: "UPDATE_TOPIC_TITLE",
  CREATE_TOPIC: "CREATE_TOPIC",
  READ_TOPIC: "READ_TOPIC",
  MOVE_TOPIC: "MOVE_TOPIC",
  STICK_TOPIC: "STICK_TOPIC",
  UNSTICK_TOPIC: "UNSTICK_TOPIC",
  HIDE_TOPIC: "HIDE_TOPIC",
  UNHIDE_TOPIC: "UNHIDE_TOPIC",
  CLOSE_TOPIC: "CLOSE_TOPIC",
  OPEN_TOPIC: "OPEN_TOPIC",
  SUBSCRIBE_TOPIC: "SUBSCRIBE_TOPIC",
  UNSUBSCRIBE_TOPIC: "UNSUBSCRIBE_TOPIC",
  TOPIC_BAN: "TOPIC_BAN",

  // Post Management
  CREATE_POST: "CREATE_POST",
  READ_POST: "READ_POST",
  UPDATE_POST: "UPDATE_POST",
  HIDE_POST: "HIDE_POST",
  UNHIDE_POST: "UNHIDE_POST",
  RATE_POST: "RATE_POST",

  // User Management
  UPDATE_USER: "UPDATE_USER",
  UPDATE_USER_ROLE: "UPDATE_USER_ROLE",
  GRANT_EMAIL_GATE_EXEMPTION: "GRANT_EMAIL_GATE_EXEMPTION",
  UPDATE_USER_CUSTOM_TITLE: "UPDATE_USER_CUSTOM_TITLE",
  DELETE_USER: "DELETE_USER",
  READ_USER_ONLINE_STATUS: "READ_USER_ONLINE_STATUS",
  READ_USER_PM_SENT_COUNT: "READ_USER_PM_SENT_COUNT",
  READ_USER_RATINGS_TABLE: "READ_USER_RATINGS_TABLE",
  READ_USER_IP: "READ_USER_IP",
  READ_USER_LIST: "READ_USER_LIST",
  NUKE_USER: "NUKE_USER",
  CHANGE_UNAME: "CHANGE_UNAME",

  // Status Management
  CREATE_USER_STATUS: "CREATE_USER_STATUS",
  DELETE_USER_STATUS: "DELETE_USER_STATUS",
  MANAGE_USER_STATUS: "MANAGE_USER_STATUS",
  LIKE_STATUS: "LIKE_STATUS",

  // Trophy System
  MANAGE_TROPHY_SYSTEM: "MANAGE_TROPHY_SYSTEM",
  UPDATE_TROPHY: "UPDATE_TROPHY",
  CREATE_TROPHY_GROUP: "CREATE_TROPHY_GROUP",
  UPDATE_TROPHY_GROUP: "UPDATE_TROPHY_GROUP",

  // Private Messages & Conversations
  CREATE_CONVO: "CREATE_CONVO",
  READ_CONVO: "READ_CONVO",
  DELETE_CONVO: "DELETE_CONVO",
  CREATE_PM: "CREATE_PM",
  READ_PM: "READ_PM",
  UPDATE_PM: "UPDATE_PM",

  // Visitor Messages
  CREATE_VM: "CREATE_VM",
  DELETE_VM: "DELETE_VM",

  // Forums & Categories
  READ_FORUM: "READ_FORUM",
  READ_CATEGORY: "READ_CATEGORY",
  LEXUS_LOUNGE: "LEXUS_LOUNGE",

  // Notifications
  DELETE_NOTIFICATION: "DELETE_NOTIFICATION",

  // Images
  MANAGE_IMAGES: "MANAGE_IMAGES",
  UPLOAD_IMAGE: "UPLOAD_IMAGE",

  // Dice/Campaign System
  CREATE_CAMPAIGN: "CREATE_CAMPAIGN",
  READ_CAMPAIGN: "READ_CAMPAIGN",
  UPDATE_CAMPAIGN: "UPDATE_CAMPAIGN",
  CREATE_ROLL: "CREATE_ROLL",

  // Chat
  READ_CHATLOGS: "READ_CHATLOGS",
} as const;

// Type for the action strings
export type CanAction = (typeof CanAction)[keyof typeof CanAction];
