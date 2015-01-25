// Node
var util = require('util');
// 1st party
var db = require('./db');
var pre = require('./presenters');
var belt = require('./belt');
// 3rd party
var debug = require('debug')('app:middleware');

// Assoc ctx.currUser if the sessionId cookie (UUIDv4 String)
// is an active session.
exports.currUser = function() {
  return function *(next) {
    var sessionId = this.cookies.get('sessionId');
    // Skip if no session id
    if (!sessionId) return yield next;
    // Skip if it's not a uuid
    if (!belt.isValidUuid(sessionId)) yield next;

    var user = yield db.findUserBySessionId(sessionId);
    this.currUser = user && pre.presentUser(user);  // or null
    this.log = this.log.child({ currUser: user });
    yield next;
  };
};

// Expose req.flash (getter) and res.flash = _ (setter)
// Flash data persists in user's sessions until the next ~successful response
exports.flash = function(cookieName) {
  return function *(next) {
    var data;
    if (this.cookies.get(cookieName)) {
      data = JSON.parse(decodeURIComponent(this.cookies.get(cookieName)));
    } else {
      data = {};
    }

    Object.defineProperty(this, 'flash', {
      enumerable: true,
      get: function() {
        return data;
      },
      set: function(val) {
        this.cookies.set(cookieName, encodeURIComponent(JSON.stringify(val)));
      }
    });

    yield next;

    if (this.response.status < 300) {
      this.cookies.set(cookieName, null);
    }
  };
};
