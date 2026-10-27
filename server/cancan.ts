// Node
import util from "util";
// 3rd party
import _ from "lodash";
import createDebug from "debug";
const debug = createDebug("app:cancan");
import assert from "node:assert";
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
export const MOD_CATEGORY_ID = 4;

// The one lounge test for a forum row. It fails closed: a short or wrong row
// (say, a topic passed where its forum belongs) throws instead of reading as
// "not lounge", which would allow.
function isModForum(forum: any): boolean {
  assert(forum, "forum is missing");
  assert(
    Number.isInteger(forum.category_id),
    "forum.category_id must be an integer",
  );
  return forum.category_id === MOD_CATEGORY_ID;
}

// The one list of roles that may read the lounge forums, their topics and
// their category. READ_POST asks LEXUS_LOUNGE instead, a narrower set that
// keeps conmods and arenamods out of lounge posts; which set is right is an
// open question.
function mayEnterModForums(user: any): boolean {
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

export const isTopicGm = (user: any, topic: any) => {
  assert(topic);
  assert(Array.isArray(topic.co_gm_ids));
  if (!user) return false;
  if (user.id === topic.user_id) return true;
  if (topic.co_gm_ids.some((id) => id === user.id)) return true;
  return false;
};

// The read rule each action also requires. can() asks it before the action's
// own rule, so writes never restate the lounge and hidden rules that
// READ_FORUM, READ_TOPIC and READ_POST own. The Record type makes every new
// action declare its gate; null means the action has none.
const READ_GATE: Record<CanAction, CanAction | null> = {
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
};

// banned_ids is not a topics column: only loaders that select it from
// topic_bans carry it (server/db/readable.ts#BANNED_IDS_COLUMN). The rules that
// deny on it assert it before any role branch, so a short row throws instead
// of reading as "no bans" and letting a banned member through.
function assertBansLoaded(target: any) {
  assert(target);
  assert(Array.isArray(target.banned_ids), "target.banned_ids is not loaded");
}

// TODO: Actually write tests for these
// TODO: Implement rules for all rules, not just member and admin
export const can = function (user: any, action: CanAction, target?: any) {
  const gate = READ_GATE[action];
  var result =
    gate !== null && !can(user, gate, target)
      ? false
      : _can(user, action, target);
  debug(
    "[cancan] %s %s %s %s %s: %s",
    (user && util.format("%s [%d]", user.uname, user.id)) || "<Guest>",
    // can/cannot
    (result ? "\u001b[1;32m can" : "\u001b[1;31m cannot") + " \u001b[0m",
    action,
    target && util.format("[%s]", target.id),
    ((target && JSON.stringify(target)) || "undefined").slice(0, 50),
  );
  return result;
};

// A banned user's writes stop at
// server/middleware/require-not-banned.ts#requireNotBanned before any route
// asks. In a write rule below, a `user.role === "banned"` line is a UI hint: it
// hides a control that gate would refuse.
function _can(
  user: any,
  action: CanAction,
  target: any | undefined = undefined,
) {
  switch (action) {
    case "ACCESS_TOPIC_MODKIT": // target is topic
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
      if ((target.mods || []).some((m) => m.id === user.id)) {
        return true;
      }
      return false;
    case "MANAGE_TROPHY_SYSTEM": // no target, intended to wrap all privs
    case "UPDATE_TROPHY": // target is trophy
    case "CREATE_TROPHY_GROUP": // no target
    case "UPDATE_TROPHY_GROUP": // target is trophy-group
      // Guests can't
      if (!user) return false;
      // Conmods can
      if (user.role === "conmod") return true;
      // Admin can
      if (user.role === "admin") return true;
      return false;
    case "DELETE_NOTIFICATION": // target is notification
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === "banned") return false;
      // User can if it's their notification
      if (user.id === target.to_user_id) return true;
      return false;
    // TODO: Replace this with MANAGE_USER_STATUS
    case "DELETE_USER_STATUS": // target is status
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === "banned") return false;
      // User can delete their own statuses
      if (user.id === target.user_id) return true;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case "MANAGE_USER_STATUS": // target is user
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === "banned") return false;
      // User can delete their own statuses
      if (user.id === target.id) return true;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case "LIKE_STATUS": // target status
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === "banned") return false;
      // Users can't like if its their own status
      if (user.id === target.user_id) return false;
      // Users can like it if they haven't already liked it
      if (!target.liked_user_ids.includes(user.id)) return true;
      return false;
    case "CREATE_USER_STATUS": // target is user
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === "banned") return false;
      // User can update themself
      if (user.id === target.id) return true;
      return false;
    // Expresses user's ability to update any part of a topic
    // Only use this for high level checks like to see if a user
    // should see the "Edit Topic" link at all. The actual actions they
    // can do to a topic will vary.
    // Use the specific checks for granular authorization.
    case "UPDATE_TOPIC": // target is topic
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
    case "UPDATE_TOPIC_JOIN_STATUS": // target is topic
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
    case "UPDATE_TOPIC_TAGS": // target is topic
      assert(target.forum);
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
    case "UPDATE_TOPIC_CO_GMS": // target is topic
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
    case "UPDATE_USER_CUSTOM_TITLE": // target is user
      // Never more than profile edit, so the title route grants no power over
      // a profile whose edit page the user cannot open. Guests and banned
      // users stop here.
      if (!can(user, "UPDATE_USER", target)) return false;
      // Members and Conmods can only change their own
      if (["member", "conmod"].includes(user.role))
        return user.id === target.id;
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
    // The ratings table is on the user profile
    case "READ_USER_RATINGS_TABLE": // target is user
      // Guests cannot
      if (!user) return false;
      // Banned cannot
      if (user.role === "banned") return false;
      // Staff can read everyone's
      if (isStaffRole(user.role)) return true;
      // everyone can read their own
      return user.id === target.id;
    case "RATE_POST": // target is post
      // Guests can't rate
      if (!user) return false;
      // Banned members can't rate
      if (user.role === "banned") return false;
      // Cannot rate your own post
      if (user.id === target.user_id) return false;
      // Everyone else can if READ_GATE lets them read the post
      return true;
    case "READ_USER_LIST": // no target
      // Let guests read this for now
      return true;
    //
    // Only registered users can
    // if (!user) return false;
    // return true;
    case "UPDATE_TOPIC_TITLE": // target is topic
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
    case "READ_USER_ONLINE_STATUS": // target is user
      // Guests and members can see status if target isn't in invisible mode.
      if (!user) return !target.is_ghost;
      // Members & conmods can see themselves regardless of ghost status
      if (["member", "conmod"].includes(user.role))
        return target.id === user.id || !target.is_ghost;
      // Staff can see ghosts
      if (isStaffRole(user.role)) return true;
      return false;
    case "DELETE_USER": // target is user
      if (!user) return false;
      return user.role === "admin";
    case "READ_USER_PM_SENT_COUNT": // target is user
      // Guests cannot
      if (!user) return false;
      // Only staff can read user pm-sent count
      if (isStaffRole(user.role)) return true;
      return false;
    case "UPDATE_USER_ROLE": // target is user
      if (!user) return false;
      if (user.role === "admin") return true;
      // smods can change everyone except admin
      if (user.role === "smod") return target.role !== "admin";
      // mods can change non-staff and pw-mods
      if (user.role === "mod")
        return ["banned", "member", "pwmod"].includes(target.role);
      return false;
    case "GRANT_EMAIL_GATE_EXEMPTION": // target is user
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
    case "UPDATE_USER": // target is user
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
    // Post state -- target is post
    case "UNHIDE_POST":
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
    case "HIDE_POST":
      if (!user) return false;
      assert(target.topic);
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
    // Topic state
    case "MOVE_TOPIC":
      if (!user) return false;
      if (isStaffRole(user.role)) return true;
      return false;
    case "STICK_TOPIC":
    case "UNSTICK_TOPIC":
    case "HIDE_TOPIC":
    case "UNHIDE_TOPIC":
    case "CLOSE_TOPIC":
    case "OPEN_TOPIC":
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
      if (user.role === "pwmod" && PW_FORUMS.includes(target.forum_id))
        return true;
      // Can if they are forum mod
      if ((target.mods || []).some((m) => m.id === user.id)) {
        return true;
      }
      return false;
    case "CREATE_POST": // target is topic with banned_ids
      assertBansLoaded(target);
      if (!user) return false;
      if (user.role === "banned") return false;
      // Staff can always create posts anywhere
      if (isStaffRole(user.role)) return true;
      // Can if they are forum mod
      if ((target.mods || []).some((m) => m.id === user.id)) {
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
          debug(ANTI_NECRO_FORUMS.includes(target.forum_id));
          var t = new Date();
          t.setMonth(t.getMonth() - 1);
          return target.latest_post_at > t;
        }
        return true;
      }
      return false;
    case "READ_PM": // target is pm with pm.convo and pm.participants props
      // Guests can't
      if (!user) return false;
      // Admin can see all
      if (user.role === "admin") return true;
      return target.participants.some((p) => p.id === user.id);
    case "READ_POST": // target is post with a post.topic prop
      assert(target, "Post missing");
      assert(target.topic, "post.topic is missing");
      // Test the lounge before anything returns, so a short forum row throws
      // for every viewer
      if (isModForum(target.forum)) {
        return _can(user, "LEXUS_LOUNGE");
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
    case "READ_USER_IP": // target is a user
      if (!user) return false;
      // Staff can only see down-chain
      if (user.role === "admin") return true;
      if (user.role === "smod")
        return ["mod", "member", "banned"].includes(target.role);
      if (user.role === "mod")
        return ["member", "banned"].includes(target.role);
      return false;
    case "READ_FORUM": // target is a forum
      if (isModForum(target)) return mayEnterModForums(user);
      else return true; // for now, anyone can read a non-lexus-lounge forum
      // TODO: Forum mods should be able to read their own forum,
      // maybe it canbe hidden from others? Unlisted while they work?
      return false;
    case "LEXUS_LOUNGE": // no target
      if (!user) return false;
      // All staff can access
      if (["conmod", "arenamod"].includes(user.role)) return false;
      // conmods and arenamods can't
      if (isStaffRole(user.role)) return true;
      return false;
    // TODO: Replace LEXUS_LOUNGE with this?
    case "READ_CATEGORY": //  target is category
      // Anyone can view any category except for lexus lounge
      assert(Number.isInteger(target.id), "category.id must be an integer");
      if (target.id === MOD_CATEGORY_ID) return mayEnterModForums(user);
      else return true;
      return false;
    case "UNSUBSCRIBE_TOPIC":
      // A user can unsubscribe from a topic if they're logged in
      return !!user;
    case "SUBSCRIBE_TOPIC": // target is topic
      if (!user) return false;
      // banned cannot
      if (user.role === "banned") return false;
      // everyone else can if READ_GATE lets them read the topic
      return true;
    case "CREATE_PM": // target is convo w/ participants prop
      if (!user) return false;
      if (user.role === "banned") return false;
      // User can send pm if they're a participant
      return !!_.find(target.participants, { id: user.id });
    case "READ_TOPIC": // target is topic
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
      if (user && (target.mods || []).some((m) => m.id === user.id)) {
        return true;
      }
      if (!target.is_hidden) {
        return true;
      }
      return false;
    case "CREATE_CONVO": // no target
      if (!user) return false;
      // Any user that isn't banned can start convo
      return user.role !== "banned";
    case "CREATE_TOPIC": // target is forum
      assert(target);
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
    case "UPDATE_PM": // target is pm with pm.convo and pm.participants
      if (!user) return false;
      if (user.role === "banned") return false;
      // Can't update legacy PMs. TODO: Implement BBCode editing for PMs
      // once post BBCode system is tested
      if (target.legacy_html) return false;
      // User can update a PM if they own it
      if (target.user_id === user.id) return true;
      return false;
    case "UPDATE_POST": // target is post with post.topic and banned_ids
      assertBansLoaded(target);
      if (!user) return false;
      if (user.role === "banned") return false;
      // Admin can update any post
      if (user.role === "admin") return true;
      // GM and Co-GM can edit the 0th post
      if (target.idx === -1 && isTopicGm(user, target.topic)) {
        return true;
      }
      // Cannot update post if banned from topic
      if (target.banned_ids.includes(user.id)) return false;
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
    case "DELETE_CONVO": // target is convo
    case "READ_CONVO": // target is convo
      // Banned members can't
      if (!user) return false;
      // Admin can read all convos
      if (user.role === "admin") return true;
      // Users can only read convos they're participants of
      if (target.participants.some((x) => x.id === user.id)) return true;
      return false;
    case "DELETE_VM": // target is vm
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
    case "CREATE_VM": // no target
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === "banned") return false;
      // Everyone else can
      return true;
    case "NUKE_USER": // target is spambot user
      // guests cannot
      if (!user) return false;
      // staff can ban non-staff
      if (isStaffRole(user.role) && !isStaffRole(target.role)) return true;
      return false;
    case "MANAGE_IMAGES": // target is the user being managed
      if (!user) return false;
      if (user.role === "banned") return false;
      if (user.id === target.id) return true;
      if (isStaffRole(user.role) && !isStaffRole(target.role)) return true;
      return false;
    case "UPLOAD_IMAGE": // target is user the image is uploaded to
      if (!user) return false;
      if (user.role === "banned") return false;
      if (user.id === target.id) return true;
      return false;
    case "CHANGE_UNAME": // target is user to have their uname changed
      assert(target);
      assert(Number.isInteger(target.id));
      assert(typeof target.role === "string");
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
    //
    // DICE
    //
    case "UPDATE_CAMPAIGN": // target is campaign
      if (!user) return false;
      if (user.role === "banned") return false;
      // people can update their own campaigns
      if (user.id === target.user_id) return true;
      // staff can update any campaign
      if (isStaffRole(user.role)) return true;
      return false;
    case "READ_CAMPAIGN": // target is campaign
      // anyone can
      return true;
    case "CREATE_CAMPAIGN": // no target
      if (!user) return false;
      // anyone that's not banned can
      if (user.role !== "banned") return true;
      return false;
    // TODO: yes if they are coGM/GM of target.topic_id
    case "CREATE_ROLL": // target is campaign
      if (!user) return false;
      if (user.role === "banned") return false;
      // can if they own the campaign
      if (user.id === target.user_id) return true;
      return false;
    //
    // CHAT
    //
    case "READ_CHATLOGS": // no target
      if (!user) return false;
      if (user.id === 107) return true; // HACK: Let Ellri
      if (isStaffRole(user.role)) return true; // Only staff can
      return false;
    //
    // GM/CO-GM
    //
    case "TOPIC_BAN": // target is { topic, user }
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
    default:
      debug("Unsupported cancan action: " + action);
      return false;
  }
}

export const cannot = function (user: any, action: CanAction, target?: any) {
  return !can(user, action, target);
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
