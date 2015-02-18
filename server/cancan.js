// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:cancan');
var assert = require('better-assert');

// TODO: Actually write tests for these
// TODO: Implement rules for all rules, not just member and admin
exports.can = can;
function can(user, action, target) {
  switch(action) {
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
      // Only registered users can
      if (!user) return false;
      return true;
    case 'UPDATE_TOPIC_TITLE': // target is topic
      if (!user) return false;
      // Banned users can't update their old topics
      if (user.role === 'banned') return false;
      // Staff can edit all topic titles
      if (_.contains(['mod', 'smod', 'admin'], user.role)) return true;
      // Topic owner can edit their own titles
      return user.id === target.user_id;
    case 'READ_USER_ONLINE_STATUS': // target is user
      // Guests and members can see status if target isn't in invisible mode.
      if (!user) return !target.is_ghost;
      // Members can see themselves regardless of ghost status
      if (user.role === 'member')
        return target.id === user.id || !target.is_ghost;
      // Staff can see ghosts
      return _.contains(['mod', 'smod', 'admin'], user.role);
    case 'DELETE_USER':  // target is user
      if (!user) return false;
      return user.role === 'admin';
    case 'READ_USER_PM_SENT_COUNT':  // target is user
      if (!user) return false;
      return _.contains(['mod', 'smod', 'admin'], user.role);
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
      return !!_.contains(['mod', 'smod', 'admin'], user.role);
    // Topic state
    case 'STICK_TOPIC':
    case 'UNSTICK_TOPIC':
    case 'HIDE_TOPIC':
    case 'UNHIDE_TOPIC':
    case 'CLOSE_TOPIC':
    case 'OPEN_TOPIC':
    case 'MOVE_TOPIC':
      // Only staff can do this
      return _.contains(['mod', 'smod', 'admin'], user.role);
    case 'CREATE_POST': // target is topic
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Staff can always create posts anywhere
      if (_.contains(['admin', 'smod', 'mod'], user.role))
        return true;
      // Members can post as long as it's outside the lexus lounge,
      // the topic is open, and the topic is visible
      if (user.role === 'member') {
        if (target.category_id === 4) return false;
        if (target.is_closed) return false;
        if (target.is_hidden) return false
        // Topic latest_post_at must be newer than 1 month
        var t = new Date();
        t.setMonth(t.getMonth() - 1);
        return target.latest_post_at > t;
      }
      return false;
    case 'READ_PM': // target is pm with pm.convo and pm.participants props
      if (!user) return false;
      return !!_.find(target.participants, { id: user.id });
    case 'READ_POST': // target is post with a post.topic prop
      assert(target, 'Post missing');
      assert(target.topic, 'post.topic is missing');
      assert(target.forum, 'post.forum is missing');
      // Staff can read all posts
      if (user && _.contains(['admin', 'smod', 'mod'], user.role))
        return true;
      // Everyone else can read a post as long as it's not hidden,
      // the topic is not hidden, and the topic is not in lexus lounge
      return !target.is_hidden &&
             !target.topic.is_hidden &&
             target.forum.category_id !== 4;
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
        return user && _.contains(['admin', 'smod', 'mod'], user.role);
      else
        return true; // for now, anyone can read a non-lexus-lounge forum
      return false;
    case 'LEXUS_LOUNGE':  // no target
      if (!user) return false;
      if (_.contains(['mod', 'smod', 'admin'], user.role)) return true;
      return false;
    // TODO: Replace LEXUS_LOUNGE with this?
    case 'READ_CATEGORY':  //  target is category
      // Users can view any category except for lexus lounge
      // Only staff can view lexus lounge
      if (target.id === 4)
        return !!_.contains(['mod', 'smod', 'admin'], user.role);
      else
        return true;
    case 'UNSUBSCRIBE_TOPIC':
      // A user can unsubscribe from a topic if they're logged in
      return !!user;
    case 'SUBSCRIBE_TOPIC':  // target is topic
      if (!user) return false;
      // Members and up can subscribe if they can read the topic
      if (_.contains(['member', 'mod', 'smod', 'admin'], user.role))
        return can(user, 'READ_TOPIC', target);
      return false;
    case 'CREATE_PM': // target is convo w/ participants prop
      if (!user) return false;
      if (user.role === 'banned') return false;
      // User can send pm if they're a participant
      return !!_.find(target.participants, { id: user.id });
    case 'CREATE_POST':  // target is topic
      if (!user) return false;
      // Staff can post everywhere
      if (_.contains(['admin', 'smod', 'mod'], user.role)) return true;
      if (user.role === 'member')
        return (!target.is_hidden && !target.is_closed && target.category_id !== 4);
      return false;
    case 'READ_TOPIC':  // target is topic
      // Only staff can read lexus lounge
      if (target.category_id === 4)
        return user && _.contains(['admin', 'smod', 'mod'], user.role);
      // Only staff can see hidden topics
      if (target.is_hidden)
        return user && _.contains(['admin', 'smod', 'mod'], user.role);
      if (!target.is_hidden) return true;
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
      if (target.id === 4) {
        return _.contains(['admin', 'smod', 'mod'], user.role);
      } else {
        return _.contains(['admin', 'smod', 'mod', 'member'], user.role);
      }
      if (user.role === 'member') return true;
      return false;
    case 'UPDATE_PM':  // target is pm with pm.convo and pm.participants
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Can't update legacy PMs. TODO: Implement BBCode editing for PMs
      // once post BBCode system is tested
      if (target.legacy_html) return false;
      // User can update a PM if they own it
      return target.user_id === user.id;
    case 'UPDATE_POST':  // target expected to be a post
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Admin can update any post
      if (user.role === 'admin') return true;
      // TODO: Create rules for other staff roles
      if (user.id === target.user_id) return true;
      return false;
    case 'CREATE_CONVO':
      if (!user) return false;
      if (user.role === 'member') return true;
      return false;
    case 'READ_CONVO':
      if (!user) return false;
      // Users can only read convos they're participants of
      return !!_.findWhere(target.participants, { id: user.id });
    default:
      debug('Unsupported cancan action: ' + action);
      return false;
  }
}

exports.cannot = function(user, action, target) {
  return !can(user, action, target);
};
