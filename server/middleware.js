"use strict";
// Node
var util = require('util');
// 1st party
var db = require('./db');
var pre = require('./presenters');
var belt = require('./belt');
var config = require('./config');
var bouncer = require('koa-bouncer');
// 3rd party
var debug = require('debug')('app:middleware');
var recaptcha = require('recaptcha-validator');
var _ = require('lodash');

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
    this.state.session_id = sessionId;
    // this.log = this.log.child({ currUser: user });
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

exports.ensureRecaptcha = function * (next) {
  if (_.includes(['development', 'test'], config.NODE_ENV) && !this.request.body['g-recaptcha-response']) {
    console.log('Development mode, so skipping recaptcha check');
    yield* next;
    return;
  }

  if (!config.RECAPTCHA_SITEKEY) {
    console.warn('Warn: Recaptcha environment variables not set, so skipping recaptcha check');
    yield* next;
    return;
  }

  this.validateBody('g-recaptcha-response')
    .notEmpty('You must attempt the human test');

  try {
    yield recaptcha.promise(config.RECAPTCHA_SITESECRET, this.vals['g-recaptcha-response'], this.request.ip);
  } catch (err) {
    console.warn('Got invalid captcha: ', this.vals['g-recaptcha-response'], err);
    this.validateBody('g-recaptcha-response')
      .check(false, 'Could not verify recaptcha was correct');
    return;
  }

  yield * next;
};
