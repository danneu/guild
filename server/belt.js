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
// 1st party
var config = require('./config');

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

// reCaptcha ///////////////////////////////////////////////

// Returns Bool
exports.makeRecaptchaRequest = function *(args) {
  debug('[makeRecaptchaRequest] args: ' + util.inspect(args));
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
  debug('Response body from google: ' + util.inspect(result.body));
  if (! result.body.success)
    return false;
  else
    return true;
};
