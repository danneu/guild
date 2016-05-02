"use strict";
// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:cancan');
var assert = require('better-assert');

// These are forums where topics cannot be posted
// in if the latest post is older than 1 month
var ANTI_NECRO_FORUMS = [
  30, // Spam
  32, // Member Lounge
  33, // Off-topic
  9, // Bugs/feature requests
  36, // Need help?
  1, // News
  2, // Introduce yourself
];

var CONTEST_FORUMS = [
  45,
  44
];

// Applies to anyone above member
//
// TODO: Now that I've added the 'conmod' role, this function doesn't make
// much sense since many times I use this function (like to restrict LexusLounge
// access) I don't want to include conmods. But I would still consider them staff.
// I think I should replace this function with explicitly inlining the
// _.contains([x, y, z], role) call and removing this function.
exports.isStaffRole = isStaffRole;
function isStaffRole(role) {
  return _.contains(['mod', 'smod', 'admin'], role);
}

// TODO: Actually write tests for these
// TODO: Implement rules for all rules, not just member and admin
exports.can = function(user, action, target) {
  var result = can(user, action, target);
  debug('[cancan] %s %s %s %s %s: %s',
        (user && util.format('%s [%d]', user.uname, user.id)) || '<Guest>',
        // can/cannot
        (result ? '\u001b[1;32m can' : '\u001b[1;31m cannot') + ' \u001b[0m',
        action,
        target && util.format('[%s]', target.id),
        (target && JSON.stringify(target) || 'undefined').slice(0, 50)
       );
  return result;
};
function can(user, action, target) {
  switch(action) {
    case 'ACCESS_TOPIC_MODKIT': // target is topic
      if (!user) return false;
      if (_.contains(['mod', 'smod', 'admin'], user.role)) return true;
      if (user.role === 'conmod' && _.contains(CONTEST_FORUMS, target.forum_id))
        return true;
      return false;
    case 'MANAGE_TROPHY_SYSTEM': // no target, intended to wrap all privs
    case 'UPDATE_TROPHY': // target is trophy
    case 'CREATE_TROPHY_GROUP': // no target
    case 'UPDATE_TROPHY_GROUP': // target is trophy-group
      // Guests can't
      if (!user) return false;
      // Conmods can
      if (user.role === 'conmod') return true;
      // Admin can
      if (user.role === 'admin') return true;
      return false;
    case 'DELETE_NOTIFICATION':  // target is notification
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === 'banned') return false;
      // User can if it's their notification
      if (user.id === target.to_user_id) return true;
      return false;
    // TODO: Replace this with MANAGE_USER_STATUS
    case 'DELETE_USER_STATUS': // target is status
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === 'banned') return false;
      // User can delete their own statuses
      if (user.id === target.user_id) return true;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case 'MANAGE_USER_STATUS': // target is user
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === 'banned') return false;
      // User can delete their own statuses
      if (user.id === target.id) return true;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case 'LIKE_STATUS': // target status
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === 'banned') return false;
      // Users can't like if its their own status
      if (user.id === target.user_id) return false;
      // Users can like it if they haven't already liked it
      if (!_.contains(target.liked_user_ids, user.id)) return true;
      return false;
    case 'CREATE_USER_STATUS': // target is user
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === 'banned') return false;
      // User can update themself
      if (user.id === target.id) return true;
      return false;
    // Expresses user's ability to update any part of a topic
    // Only use this for high level checks like to see if a user
    // should see the "Edit Topic" link at all. The actual actions they
    // can do to a topic will vary.
    // Use the specific checks for granular authorization.
    case 'UPDATE_TOPIC': // target is topic
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === 'banned') return false;
      // Staff can
      if (isStaffRole(user.role)) return true;
      // Conmod can if it's in contest forums
      if (user.role === 'conmod'
          && _.contains(CONTEST_FORUMS, target.forum_id))
        return true;
      // Arena Mod can if it's in ArenaRP forum
      if (_.contains(user.roles, 'ARENA_MOD'))
        return true;
      // If non-staff, then cannot if topic is hidden/closed
      if (target.is_closed || target.is_hidden) return false;
      // GM/OP can
      if (user.id === target.user_id) return true;
      // TODO: Let GM/co-GMs do it
      // FIXME: (Sloppy) Check if user is eligible for any of the types of edits
      return can(user, 'UPDATE_TOPIC_JOIN_STATUS', target) ||
             can(user, 'UPDATE_TOPIC_TAGS', target) ||
             can(user, 'UPDATE_TOPIC_CO_GMS', target);
    case 'UPDATE_TOPIC_JOIN_STATUS':  // target is topic
      // Nobody can unless it's a roleplay
      if (!target.is_roleplay) return false;
      // Guests cant
      if (!user) return false;
      // Topic creator can
      if (user.id === target.user_id) return true;
      // co-GMs can
      if (_.contains(target.co_gm_ids, user.id)) return true;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case 'UPDATE_TOPIC_TAGS':  // target is topic
      assert(target.forum);
      // Nobody can unless forum has tags enabled
      if (!target.forum.has_tags_enabled) return false;
      // Guests never can
      if (!user) return false;
      // GM can
      if (target.user_id === user.id) return true;
      // Co-GMs can
      if (_.contains(target.co_gm_ids, user.id)) return true;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case 'UPDATE_TOPIC_CO_GMS':  // target is topic
      // Only roleplays can have co-GMs
      if (!target.is_roleplay) return false;
      // Guests can't
      if (!user) return false;
      // GM can
      if (target.user_id === user.id) return true;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case 'UPDATE_USER_CUSTOM_TITLE': // target is user
      // Guests cannot
      if (!user) return false;
      // Members and Conmods can only change their own
      if (_.contains(['member', 'conmod'], user.role))
        return user.id === target.id;
      // Mods can change their own title and the title of any non-staff
      if (user.role === 'mod')
        return user.id === target.id || !isStaffRole(target.role);
      // Smods can change mods and below
      if (user.role === 'smod')
        return user.id === target.id ||
               target.role === 'mod' ||
               !isStaffRole(target.role);
      // Admins can change all
      if (user.role === 'admin')
        return true;
      return false;
    case 'REFRESH_FORUM':  // target is forum
      // Guests cannot
      if (!user) return false;
      // Staff can
      if (isStaffRole(user.role)) return true;
      // Conmods can
      if (user.role === 'conmod') return true;
      return false;
    // The ratings table is on the user profile
    case 'READ_USER_RATINGS_TABLE': // target is user
      // Guests cannot
      if (!user) return false;
      // Banned cannot
      if (user.role === 'banned') return false;
      // Members and conmods can only read their own
      if (_.contains(['member', 'conmod'], user.role) && user.id === target.id)
        return true;
      // Staff can read everyone's
      if (isStaffRole(user.role)) return true;
      return false;
    case 'RATE_POST': // target is post
      // Guests can't rate
      if (!user) return false;
      // Banned members can't rate
      if (user.role === 'banned') return false;
      // Cannot rate your own post
      if (user.id === target.user_id ) return false;
      // Can rate if you're authorized to read post
      return can(user, 'READ_POST', target);
    case 'READ_USER_LIST': // no target
      // Let guests read this for now
      return true;
      //
      // Only registered users can
      // if (!user) return false;
      // return true;
    case 'UPDATE_TOPIC_TITLE': // target is topic
      if (!user) return false;
      // Banned users can't update their old topics
      if (user.role === 'banned') return false;
      // Staff can edit all topic titles
      if (isStaffRole(user.role)) return true;
      // Topic owner/GM can edit their own titles
      if (user.id === target.user_id) return true;
      // Co-GMs can also edit topic title
      if (_.contains(target.co_gm_ids, user.id)) return true;
      // Conmods can edit any topic in contest forums
      if (user.role === 'conmod' && _.contains(CONTEST_FORUMS, target.forum_id))
        return true;
      // Arena mods can edit topic titles in arena forum
      if (target.forum.is_arena_rp && _.contains(user.roles, 'ARENA_MOD'))
        return true;
      return false;
    case 'UPDATE_TOPIC_ARENA_OUTCOMES':  // target is topic
      // Guests can't
      if (!user)
        return false;
      // Admin can
      if (user.role === 'admin')
        return true;
      // Arena mods can if topic is in arena forum
      if (target.forum.is_arena_rp && _.contains(user.roles, 'ARENA_MOD'))
        return true;
      return false;
    case 'READ_USER_ONLINE_STATUS': // target is user
      // Guests and members can see status if target isn't in invisible mode.
      if (!user) return !target.is_ghost;
      // Members & conmods can see themselves regardless of ghost status
      if (_.contains(['member', 'conmod'], user.role))
        return target.id === user.id || !target.is_ghost;
      // Staff can see ghosts
      if (isStaffRole(user.role)) return true;
      return false;
    case 'DELETE_USER':  // target is user
      if (!user) return false;
      return user.role === 'admin';
    case 'READ_USER_PM_SENT_COUNT':  // target is user
      // Guests cannot
      if (!user) return false;
      // Only staff can read user pm-sent count
      if (isStaffRole(user.role)) return true;
      return false;
    case 'UPDATE_USER_ROLE': // target is user
      if (!user) return false;
      if (user.role === 'admin') return true;
      // Staff can change staff below them
      if (_.contains(['banned', 'member'], target.role))
        return _.contains(['mod', 'smod'], user.role);
      if (target.role === 'mod')
        return user.role === 'smod';
      return false;
    case 'UPDATE_USER':  // target is user
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Anyone can update themselves
      if (user.id === target.id) return true;
      // Staff can change staff below them
      if (user.role === 'admin') return true;
      if (_.contains(['banned', 'member'], target.role))
        return _.contains(['mod', 'smod'], user.role);
      if (target.role === 'mod')
        return user.role === 'smod';
      return false;
    // Post state -- target is post
    case 'UNHIDE_POST':
    case 'HIDE_POST':
      if (!user) return false;
      // Staff can hide/unhide
      if (isStaffRole(user.role)) return true;
      // So can conmods
      if (user.role === 'conmod') return true;
      return false;
    // Topic state
    case 'STICK_TOPIC':
    case 'UNSTICK_TOPIC':
    case 'HIDE_TOPIC':
    case 'UNHIDE_TOPIC':
    case 'CLOSE_TOPIC':
    case 'OPEN_TOPIC':
    case 'MOVE_TOPIC':
      // Guests cannot
      if (!user) return false;
      // Only staff can do this
      if (isStaffRole(user.role)) return true;
      // Conmods can manage topics in contest forums
      if (user.role === 'conmod' && _.contains(CONTEST_FORUMS, target.forum_id))
        return true;
      return false;
    case 'CREATE_POST': // target is topic
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Staff can always create posts anywhere
      if (isStaffRole(user.role)) return true;
      // Conmods can always post in contest subforums
      if (user.role === 'conmod') {
        if (_.contains(CONTEST_FORUMS, target.id)) return true;
        // conmods can't lexus lounge
        if (target.category_id === 4) return false;
        return true;
      }
      // Members can post as long as it's outside the lexus lounge,
      // the topic is open, and the topic is visible
      if (user.role === 'member') {
        if (target.category_id === 4) return false;
        if (target.is_closed) return false;
        if (target.is_hidden) return false;

        // Topic latest_post_at must be newer than 1 month
        // if in certain forums where necro'ing is disruptive
        if (_.contains(ANTI_NECRO_FORUMS, target.forum_id)) {
          debug(_.contains(ANTI_NECRO_FORUMS, target.forum_id));
          var t = new Date();
          t.setMonth(t.getMonth() - 1);
          return target.latest_post_at > t;
        }
        return true;
      }
      return false;
    case 'READ_PM': // target is pm with pm.convo and pm.participants props
      // Guests can't
      if (!user) return false;
      // Admin can see all
      if (user.role === 'admin') return true;
      return !!_.find(target.participants, { id: user.id });
    case 'READ_POST': // target is post with a post.topic prop
      assert(target, 'Post missing');
      assert(target.topic, 'post.topic is missing');
      assert(target.forum, 'post.forum is missing');
      // Staff can read all posts
      if (user && isStaffRole(user.role)) return true;
      // conmods can read all posts in contest forums
      if (user
          && user.role === 'conmod'
          && _.contains(CONTEST_FORUMS, target.topic.forum_id))
        return true;
      // Everyone else can read a post as long as it's not hidden,
      // the topic is not hidden, and the topic is not in lexus lounge
      return !target.is_hidden &&
             !target.topic.is_hidden &&
             target.forum.category_id !== 4;
    case 'LOOKUP_IP_ADDRESS': // no target
      // Guests cannot
      if (!user) return false;
      // Staff can
      if (isStaffRole(user.role)) return true;
      return false;
    case 'READ_USER_IP': // target is a user
      if (!user) return false;
      // Staff can only see down-chain
      if (user.role === 'admin')
        return true;
      if (user.role === 'smod')
        return _.contains(['mod', 'member', 'banned'], target.role);
      if (user.role === 'mod')
        return _.contains(['member', 'banned'], target.role);
      return false;
    case 'READ_FORUM':  // target is a forum
      // TODO: Remove hardcoded mod forum
      if (target.category_id === 4)
        return user && isStaffRole(user.role);
      else
        return true; // for now, anyone can read a non-lexus-lounge forum
      return false;
    case 'LEXUS_LOUNGE':  // no target
      if (!user) return false;
      // All staff can access
      if (isStaffRole(user.role)) return true;
      return false;
    // TODO: Replace LEXUS_LOUNGE with this?
    case 'READ_CATEGORY':  //  target is category
      // Users can view any category except for lexus lounge
      // Only staff can view lexus lounge
      if (target.id === 4)
        return !!_.contains(['mod', 'smod', 'admin'], user.role);
      else
        return true;
      return false;
    case 'UNSUBSCRIBE_TOPIC':
      // A user can unsubscribe from a topic if they're logged in
      return !!user;
    case 'SUBSCRIBE_TOPIC':  // target is topic
      if (!user) return false;
      // Members and up can subscribe if they can read the topic
      if (_.contains(['member', 'mod', 'smod', 'admin', 'conmod'], user.role))
        return can(user, 'READ_TOPIC', target);
      return false;
    case 'CREATE_PM': // target is convo w/ participants prop
      if (!user) return false;
      if (user.role === 'banned') return false;
      // User can send pm if they're a participant
      return !!_.find(target.participants, { id: user.id });
    case 'READ_TOPIC':  // target is topic
      assert(target.forum);
      // Only staff can read lexus lounge
      if (target.forum.category_id === 4)
        return user && isStaffRole(user.role);
      // conmod can read any topic in contests forum
      if (user && user.role === 'conmod' && _.contains(CONTEST_FORUMS, target.forum_id))
        return true;
      // Only staff can see hidden topics
      if (target.is_hidden)
        return user && isStaffRole(user.role);
      if (!target.is_hidden) return true;
      // Conmods can read any topic in the contest forums
      if (user.role === 'conmod')
        return _.contains(CONTEST_FORUMS, target.forum_id);
      return false;
    case 'CREATE_CONVO':  // no target
      if (!user) return false;
      // Any user that isn't banned can start convo
      return user.role !== 'banned';
    case 'CREATE_TOPIC':  // target is forum
      assert(target);
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Members can create topics in any category that's not Lexus Lounge
      if (user.role === 'member') return target.category_id !== 4;
      // Only staff can create topics in lexus lounge
      if (target.id === 4) return isStaffRole(user.role);
      if (_.contains(['mod', 'conmod', 'smod', 'admin'], user.role)) return true;
      if (user.role === 'member') return true;
      return false;
    case 'UPDATE_PM':  // target is pm with pm.convo and pm.participants
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Can't update legacy PMs. TODO: Implement BBCode editing for PMs
      // once post BBCode system is tested
      if (target.legacy_html) return false;
      // User can update a PM if they own it
      if (target.user_id === user.id) return true;
      return false;
    case 'UPDATE_POST':  // target expected to be a post
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Admin can update any post
      if (user.role === 'admin') return true;
      // TODO: Create rules for other staff roles
      if (user.id === target.user_id) return true;
      return false;
    case 'READ_CONVO':
      // Banned members can't
      if (!user) return false;
      // Admin can read all convos
      if (user.role === 'admin') return true;
      // Users can only read convos they're participants of
      if (_.findWhere(target.participants, { id: user.id })) return true;
      return false;
    case 'CREATE_VM':  // no target
      // Guests can't
      if (!user) return false;
      // Banned can't
      if (user.role === 'banned') return false;
      // Everyone else can
      return true;
    case 'NUKE_USER': // target is spambot user
      // guests cannot
      if (!user) return false;
      // staff can ban non-staff
      if (isStaffRole(user.role) && !isStaffRole(target.role)) return true;
      return false;
    case 'MANAGE_IMAGES': // target is the user being managed
      if (!user) return false;
      if (user.role === 'banned') return false;
      if (user.id === target.id) return true;
      if (isStaffRole(user.role) && !isStaffRole(target.role)) return true;
      return false;
    case 'UPLOAD_IMAGE': // target is user the image is uploaded to
      if (!user) return false;
      if (user.role === 'banned') return false;
      if (user.id === target.id) return true;
      return false;
    //
    // DICE
    //
    case 'UPDATE_CAMPAIGN': // target is campaign
      if (!user) return false;
      if (user.role === 'banned') return false;
      // people can update their own campaigns
      if (user.id === target.user_id) return true;
      // staff can update any campaign
      if (isStaffRole(user.role)) return true;
      return false;
    case 'READ_CAMPAIGN': // target is campaign
      // anyone can
      return true;
    case 'CREATE_CAMPAIGN': // no target
      if (!user) return false;
      // anyone that's not banned can
      if (user.role !== 'banned') return true;
      return false;
    // TODO: yes if they are coGM/GM of target.topic_id
    case 'CREATE_ROLL': // target is campaign
      if (!user) return false;
      if (user.role === 'banned') return false;
      // can if they own the campaign
      if (user.id === target.user_id) return true;
      return false;
    default:
      debug('Unsupported cancan action: ' + action);
      return false;
  }
}

exports.cannot = function(user, action, target) {
  return !can(user, action, target);
};
