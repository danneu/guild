// Node
var util = require('util');
// 1st party
var db = require('./db');
var pre = require('./presenters');
// 3rd party
var debug = require('debug')('app:middleware');

// Assoc ctx.currUser if the sessionId cookie (UUIDv4 String)
// is an active session.
exports.currUser = function() {
  return function *(next) {
    var sessionId = this.cookies.get('sessionId');
    debug('[wrapCurrUser] sessionId: ' + sessionId);
    if (! sessionId) return yield next;
    var user = yield db.findUserBySessionId(sessionId);
    if (user)
      this.currUser = pre.presentUser(user);
    if (user) {
      debug('[wrapCurrUser] User found');
    } else {
      debug('[wrapCurrUser] No user found');
    }
    yield next;
  };
};

// Expose req.flash (getter) and res.flash = _ (setter)
// Flash data persists in user's sessions until the next ~successful response
exports.flash = function(cookieName) {
  return function *(next) {
    var data;
    if (this.cookies.get(cookieName)) {
      data = JSON.parse(this.cookies.get(cookieName));
    } else {
      data = {};
    }

    Object.defineProperty(this, 'flash', {
      enumerable: true,
      get: function() {
        return data;
      },
      set: function(val) {
        this.cookies.set(cookieName, JSON.stringify(val));
      }
    });

    yield next;

    if (this.response.status < 300) {
      this.cookies.set(cookieName, null);
    }
  };
};
