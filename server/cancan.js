// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:cancan');

// TODO: Implement rules for all rules, not just member and admin
exports.can = can;
function can(user, action, target) {
  debug('[can] user: ' + user);

  // Admin can do all
  if (user && user.role === 'admin') return true;

  switch(action) {
    case 'SUBSCRIBE_TOPIC':
      if (!user) return false;
      if (user.role === 'member') return true
      return false;
    case 'CREATE_POST':
      if (user.role === 'member') return true;
      return false;
    case 'READ_TOPIC':
      // TODO: Ensure nonmods cant read modforums and members cant see hidden
      return true;
    case 'CREATE_TOPIC':
      if (!user) return false;
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
