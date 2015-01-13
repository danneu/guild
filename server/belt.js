// Node
var util = require('util');
var url = require('url');
var crypto = require('crypto');
// 3rd party
var promissory = require('promissory');
var assert = require('better-assert');
var _bcrypt = require('bcryptjs');
var request = require('co-request');
var debug = require('debug')('app:belt');
var _ = require('lodash');
var uuid = require('node-uuid');
// 1st party
var config = require('./config');

////
//// This module is a general utility-belt of functions.
//// Somewhat of a junk drawer.
////

exports.futureDate = function(nowDate, opts) {
  // assert(opts.years || opts.days || opts.minutes ||
  //        opts.seconds || opts.milliseconds);

  return new Date(nowDate.getTime() +
                  (opts.years   || 0) * 1000 * 60 * 60 * 24 * 365 +
                  (opts.days    || 0) * 1000 * 60 * 60 * 24 +
                  (opts.minutes || 0) * 1000 * 60 +
                  (opts.seconds || 0) * 1000 +
                  (opts.milliseconds || 0));
};

exports.md5 = md5;
function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

// {{ 'firetruck'|truncate(5) }}  -> 'firet...'
// {{ 'firetruck'|truncate(6) }}  -> 'firetruck'
exports.makeTruncate = function(suffix) {
  return function(str, n) {
    suffix = suffix || '';
    var sliced = str.slice(0, n).trim();
    var totalLength = sliced.length + suffix.length;
    if (totalLength >= str.length)
      return str;
    return sliced + suffix;
  };
};

exports.truncate = exports.makeTruncate('...');

// Logging helper
exports.truncateStringVals = function(obj) {
  var out = {};
  for (var k in obj) {
    console.log(k)
    if (obj.hasOwnProperty(k)) {
      var v = obj[k];
      if (_.isString(v))
        out[k] = exports.truncate(v, 100);
      else
        out[k] = v;
    }
  }
  return out;
};

/// Convenience functions for working with the this.errors
/// object provided by koa-validate

// errObj is the this.errors object from koa-validate
// Maybe Object -> Maybe [String]
exports.extractErrors = function(errObj) {
  return errObj &&  _.chain(errObj).map(_.values)
                                   .map(function(s) { return s.join(', '); })
                                   .value();
};

// Maybe Object -> Maybe String
exports.joinErrors = function(errObj) {
  return errObj && exports.extractErrors(errObj).join(', ');
};

////////////////////////////////////////////////////////////
// Authentication
////////////////////////////////////////////////////////////

// Wrap bcryptjs with Promises
var bcrypt = {
  // Sig: hash(password, salt)
  hash: promissory(_bcrypt.hash),
  // Sig: compare(rawPassword, hashedPassword)
  compare: promissory(_bcrypt.compare)
};

// String (Text) -> String (Hex)
exports.hashPassword = hashPassword;
function* hashPassword(password) {
  return yield bcrypt.hash(password, 4);
}

// String -> String -> Bool
exports.checkPassword = checkPassword;
function* checkPassword(password, digest) {
  return yield bcrypt.compare(password, digest);
}

////////////////////////////////////////////////////////////

// String -> Bool
exports.isValidUuid = function(uuid) {
  var regexp = /^[a-f0-9]{8}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{12}$/;
  return regexp.test(uuid);
};

// -> String
exports.generateUuid = function() {
  return uuid.v4();
};

// reCaptcha ///////////////////////////////////////////////

// Returns Bool
exports.makeRecaptchaRequest = function *(args) {
  debug('[makeRecaptchaRequest] args: ', args);
  assert(config.RECAPTCHA_SITESECRET);
  assert(_.isString(args.userResponse));
  assert(_.isString(args.userIp));
  var googleUrl = url.format({
    pathname: 'https://www.google.com/recaptcha/api/siteverify',
    query: {
      secret: config.RECAPTCHA_SITESECRET,
      response: args.userResponse,
      remoteip: args.userIp
    }
  });
  // Docs: https://developers.google.com/recaptcha/docs/verify
  // Body will look like:
  // {
  //    "success": true | false,
  //    "error-codes":  [...]      // Optional
  // }
  var result = yield request({ url: googleUrl, json: true });
  debug('Response body from google: ', result.body);
  if (! result.body.success)
    return false;
  else
    return true;
};

////////////////////////////////////////////////////////////

// pageParam comes from the query string (the client). ?page={pageParam}
// The route should ensure that it's a number since routes shouldn't
// let bad input infect the rest of the system. It can also be undefined.
//
// This function is for use in routes to calculate currPage (Int) and
// totalPages (Int) for use in the view-layer's paginate.render macro
// to generate prev/next button for arbitrary collections.
exports.calcPager = function(pageParam, perPage, totalItems) {
  assert(_.isNumber(totalItems));
  assert(_.isNumber(perPage));
  pageParam = pageParam || 1;
  debug('[calcPager] pageParam: ', pageParam);
  assert(_.isNumber(pageParam));
  var currPage, totalPages;

  totalPages = Math.ceil(totalItems / perPage);

  currPage = Math.max(pageParam, 1);
  currPage = Math.min(pageParam, totalPages);

  var result = {
    currPage: currPage,
    totalPages: totalPages,
    offset: Math.max(0, perPage * (currPage - 1)),
    limit: perPage
  };
  debug('[calcPager] result: ', result);
  return result;
};

// Returns a number >= 1
exports.calcTotalPostPages = function(totalItems) {
  return Math.max(1, Math.ceil(totalItems / config.POSTS_PER_PAGE));
};

// FIXME: This is a sloppy was to see if an object is a co-pg client
exports.isDBClient = function(obj) {
  var keys = Object.keys(obj);

  return _.contains(keys, 'database') &&
         _.contains(keys, 'connection') &&
         _.contains(keys, 'readyForQuery') &&
         _.contains(keys, 'hasExecuted') &&
         _.contains(keys, 'queryQueue');
};
