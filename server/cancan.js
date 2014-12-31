// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:cancan');

exports.can = can;
function can(user, action, target) {
  // Admin can do all
  if (user && user.role === 'admin') return true;
  switch(action) {
    case 'READ_CONVO':
      switch(user.role) {
        case 'member':
          return !!_.findWhere(target.participants, { id: user.id });
      }
      break;
    default:
      return false;
  }
}

exports.cannot = function(user, action, target) {
  return !can(user, action, target);
};

exports.ensure = function*(user, action, target) {
  if (can(user, action, target))
    return true;
  else {
    this.flash = { message: ['danger', 'Unauthorized'] };
    this.response.redirect('/');
    return;
  }
};
