// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:cancan');

exports.can = can;
function can(user, action, target) {
  debug('[can] user: ' + util.inspect(user));
  // Admin can do all
  if (user && user.role === 'admin') return true;
  switch(action) {
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

// TODO: Perhaps provide a way to pass in redirect path? Don't always want to
//       redirect to homepage.
exports.ensure = function*(user, action, target) {
  if (can(user, action, target))
    return true;
  else {
    this.flash = { message: ['danger', 'Unauthorized'] };
    this.response.redirect('/');
    return;
  }
};
