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
  // Admin can do all
  if (user && user.role === 'admin') return true;

  switch(action) {
    case 'CREATE_POST': // target is topic
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Staff can always create posts anywhere
      if (_.contains(['admin', 'smod', 'mod'], user.role))
        return true;
      // Members can post as long as it's outside the lexus lounge,
      // the topic is open, and the topic is visible
      if (user.role === 'member')
        return target.category_id !== 6 && !target.is_closed && !target.is_hidden
      return false;
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
             target.forum.category_id !== 6;
    case 'READ_USER_IP': // target is a user
      if (!user) return false;
      // Staff can only see down-chain
      if (user.role === 'smod')
        return _.contains(['mod', 'member', 'banned'], target.role);
      if (user.role === 'mod')
        return _.contains(['member', 'banned'], target.role);
      return false;
    case 'READ_FORUM':  // target is a forum
      // TODO: Remove hardcoded mod forum
      if (target.category_id === 6)
        return user && _.contains(['admin', 'smod', 'mod'], user.role);
      else
        return true; // for now, anyone can read a non-lexus-lounge forum
      return false;
    case 'LEXUS_LOUNGE':  // no target
      if (!user) return false;
      if (_.contains(['mod', 'smod', 'admin'], user.role)) return true;
      return false;
    case 'SUBSCRIBE_TOPIC':  // target is topic
      // Someone can subscribe if they can read the topic
      return can(user, 'READ_TOPIC', target);
    case 'CREATE_POST':  // target is topic
      if (!user) return false;
      // Staff can post everywhere
      if (_.contains(['admin', 'smod', 'mod'], user.role)) return true;
      if (user.role === 'member')
        return (!target.is_hidden && !target.is_closed && !target.category_id === 6);
      return false;
    case 'READ_TOPIC':  // target is topic
      // Only staff can read lexus lounge
      if (target.category_id === 6)
        return user && _.contains(['admin', 'smod', 'mod'], user.role);
      // Only staff can see hidden topics
      if (target.is_hidden)
        return user && _.contains(['admin', 'smod', 'mod'], user.role);
      if (!target.is_hidden) return true;
      return false;
    case 'CREATE_TOPIC':  // target is category
      assert(target);
      if (!user) return false;
      if (user.role === 'banned') return false;
      // Members can create topics in any category that's not Lexus Lounge
      if (user.role === 'member') return target.id !== 6;
      // Only staff can create topics in lexus lounge
      if (target.id === 6) {
        return _.contains(['admin', 'smod', 'mod'], user.role);
      } else {
        return _.contains(['admin', 'smod', 'mod', 'member'], user.role);
      }
      if (user.role === 'member') return true;
      return false;
    case 'UPDATE_POST':  // target expected to be a topic
      if (!user) return false;
      if (user.id === target.user_id) return true;
      return false;
    case 'CREATE_CONVO':
      if (!user) return false;
      if (user.role === 'member') return true;
      return false;
    case 'READ_CONVO':
      if (!user) return false;
      // Members can only read convos they're participants of
      if (user.role === 'member')
        return !!_.findWhere(target.participants, { id: user.id });
      return false;
    default:
      return false;
  }
}

exports.cannot = function(user, action, target) {
  return !can(user, action, target);
};
