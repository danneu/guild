// Node
var util = require('util');
var url = require('url');
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
