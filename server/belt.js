'use strict';
// Node
var util = require('util');
var url = require('url');
var crypto = require('crypto');
// 3rd party
var debug = require('debug')('app:belt');
var promissory = require('promissory');
var assert = require('better-assert');
var _bcrypt = require('bcryptjs');
var request = require('co-request');
var _ = require('lodash');
var uuid = require('node-uuid');
var Autolinker = require('autolinker');
var recaptchaValidator = require('recaptcha-validator');
// 1st party
var config = require('./config');

////
//// This module is a general utility-belt of functions.
//// Somewhat of a junk drawer.
////

exports.dateToSeconds = function(date) {
  return Math.floor(date.getTime() / 1000);
};

function dateToUTC(date) {
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
}

Date.prototype.toUTCDate = function() {
  return dateToUTC(this);
};

exports.isNewerThan = function(nowDate, opts) {
  var result = nowDate.toUTCDate() > exports.pastDate(new Date(), opts).toUTCDate();
  return result;
};

exports.pastDate = function(nowDate, opts) {
  if (!opts) {
    opts = nowDate;
    nowDate = new Date();
  }

  return new Date(nowDate.getTime() - (
                    (opts.years   || 0) * 1000 * 60 * 60 * 24 * 365 +
                    (opts.days    || 0) * 1000 * 60 * 60 * 24 +
                    (opts.hours   || 0) * 1000 * 60 * 60 +
                    (opts.minutes || 0) * 1000 * 60 +
                    (opts.seconds || 0) * 1000 +
                    (opts.milliseconds || 0)
                 ));
};

exports.futureDate = function(nowDate, opts) {
  if (!opts) {
    opts = nowDate;
    nowDate = new Date();
  }

  return new Date(nowDate.getTime() +
                  (opts.years   || 0) * 1000 * 60 * 60 * 24 * 365 +
                  (opts.days    || 0) * 1000 * 60 * 60 * 24 +
                  (opts.hours   || 0) * 1000 * 60 * 60 +
                  (opts.minutes || 0) * 1000 * 60 +
                  (opts.seconds || 0) * 1000 +
                  (opts.milliseconds || 0));
};

exports.md5 = function(s) {
  return crypto.createHash('md5').update(s).digest('hex');
};

// {{ 'firetruck'|truncate(5) }}  -> 'firet...'
// {{ 'firetruck'|truncate(6) }}  -> 'firetruck'
exports.makeTruncate = function(suffix) {
  return function(str, n) {
    if (!str) return str;
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
exports.hashPassword = function*(password) {
  return yield bcrypt.hash(password, 4);
};

// String -> String -> Bool
exports.checkPassword = function*(password, digest) {
  return yield bcrypt.compare(password, digest);
};

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
exports.makeRecaptchaRequest = function *(userResponse, remoteIp) {
  assert(config.RECAPTCHA_SITESECRET);
  assert(_.isString(userResponse));
  assert(_.isString(remoteIp));

  try {
    yield recaptchaValidator.promise(config.RECAPTCHA_SITESECRET, userResponse, remoteIp);
    return true;
  } catch(err) {
    if (typeof err === 'string') {
      return false;
    }
    throw err;
  }
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

exports.slugifyUname = function(uname) {
  var slug = uname
    .trim()
    .toLowerCase()
    .replace(/ /g, '-');

  return slug;
};

var MAX_SLUG_LENGTH = 80;
var slugify = exports.slugify = function() {
  // Slugifies one string
  function slugifyString(x) {
    return x.toString()
      .trim()
      // Remove apostrophes
      .replace(/'/g, '')
      // Hyphenize anything that's not alphanumeric, hyphens, or spaces
      .replace(/[^a-z0-9- ]/ig, '-')
      // Replace spaces with hyphens
      .replace(/ /g, '-')
      // Consolidate consecutive hyphens
      .replace(/-{2,}/g, '-')
      // Remove prefix and suffix hyphens
      .replace(/^[-]+|[-]+$/, '')
      .toLowerCase();
  }

  var args = Array.prototype.slice.call(arguments, 0);

  return slugifyString(
    args.map(function(x) { return x.toString(); })
      .join('-')
      .slice(0, MAX_SLUG_LENGTH)
  );
};

// Returns Int | null
var extractId = exports.extractId = function(slug) {
  var n = parseInt(slug, 10);
  return _.isNaN(n) ? null : n;
};

////////////////////////////////////////////////////////////

// Returns Array of uniq lowecase unames that were quote-mentioned in the string
// A [@Mention] is only extracted if it's not nested inside a quote.
exports.extractMentions = function(str, unameToReject) {
  var start = Date.now();
  debug('[extractMentions]');
  var unames = {};
  var re = /\[(quote)[^\]]*\]|\[(\/quote)\]|\[@([a-z0-9_\- ]+)\]/gi;
  var quoteStack = [];

  // Stop matching if we've hit notification limit for the post
  var limitRemaining = config.MENTIONS_PER_POST;
  assert(_.isNumber(limitRemaining));

  while(true) {
    var match = re.exec(str);
    if (limitRemaining > 0 && match) {
      // match[1] is undefined or 'quote'
      // match[2] is undefined or '/quote'
      // match[3] is undefined or uname
      if (match[1]) {  // Open quote
        quoteStack.push('quote');
      } else if (match[2]) {  // Close quote
        quoteStack.pop();
      } else if (match[3]) {  // uname
        var uname = match[3].toLowerCase();
        if (quoteStack.length === 0 && uname !== unameToReject.toLowerCase()) {
          unames[uname] = true;
          limitRemaining--;
          debug('limitRemaining: %s', limitRemaining);
        }
      }
    } else {
      break;
    }
  }

  var ret = Object.keys(unames);

  var diff = Date.now() - start;
  debug('[PERF] extractMentions executed in %s ms', diff);

  return ret;
};

// Returns array of uniq lowercase unames that were quote-mentioned
// i.e. [quote=@some user]
// Only top-level quote-mentions considered
exports.extractQuoteMentions = function(str, unameToReject) {
  var start = Date.now();
  debug('[extractQuoteMentions]');
  var unames = {};
  var re = /\[(quote)=?@?([a-z0-9_\- ]+)\]|\[(\/quote)\]/gi;
  var quoteStack = [];

  // Stop matching if we've hit notification limit for the post
  var limitRemaining = config.MENTIONS_PER_POST;
  assert(_.isNumber(limitRemaining));

  while(true) {
    var match = re.exec(str);
    if (limitRemaining > 0 && match) {
      // match[1] is undefined or 'quote'
      // match[2] is undefined or uname
      // match[3] is undefined or /uname
      if (match[2]) {  // Uname
        var uname = match[2].toLowerCase();
        if (quoteStack.length === 0 && uname !== unameToReject.toLowerCase()) {
          unames[uname] = true;
          limitRemaining--;
          debug('limitRemaining: %s', limitRemaining);
        }
      }
      if (match[1]) {  // Open quote
        quoteStack.push('quote');
      }
      if (match[3]) {  // Close quote
        quoteStack.pop();
      }
    } else {
      break;
    }
  }

  var ret = Object.keys(unames);

  var diff = Date.now() - start;
  debug('[PERF] extractMentions executed in %s ms', diff);

  return ret;
};


exports.frequencies = function(objs, prop) {
  return _.chain(objs)
   .groupBy(prop)
   .pairs()
   .reduce(function(memo, pair) {
     var key = pair[0];
     var vals = pair[1];
     memo[key] = vals.length;
     return memo;
   }, {})
   .value();
};

// expandJoinStatus('full') => 'Roleplay is not accepting new players'
exports.expandJoinStatus = function(status) {
  switch(status) {
  case 'jump-in':
    return 'Players can join and begin posting IC without GM approval';
  case 'apply':
    return 'Players should apply and get GM approval before posting IC';
  case 'full':
    return 'Roleplay is not accepting new players';
  default:
    return '';
  }
};

exports.mapMethod = function mapMethod(items, method) {
  return items.map(function(item) {
    return item[method]();
  });
};

////////////////////////////////////////////////////////////

// Number -> String
//
// Example:
//
//    ordinalize(1) -> '1st'
//    ordinalize(12) -> '12th'
exports.ordinalize = function(n) {
  assert(Number.isInteger(n));
  return n.toString() + exports.getOrdinalSuffix(n);
};

exports.getOrdinalSuffix = function (n) {
  assert(Number.isInteger(n));
  return Math.floor(n / 10) === 1
      ? 'th'
      : (n % 10 === 1
        ? 'st'
        : (n % 10 === 2
          ? 'nd'
          : (n % 10 === 3
            ? 'rd'
            : 'th')));
};

// TODO: Didn't realize I had this function
// just now when I added Autolinker to BBCode parser output.
// I should reuse this function.
// - bbcode.js (server/client)
// - bbcode_editor.js (client)
// At least keep this all sync'd up.
// TODO: Allow me to pass in `opts` obj that's merge with
// my default opts.
exports.autolink = function(text) {
  return Autolinker.link(text, {
    stripPrefix: true,
    newWindow: true,
    truncate: 30,
    twitter: false,
    email: false,
    phone: false,
    hashtag: false
  });
};

// String -> String
exports.escapeHtml = function(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

// Apparently the Expires date string needs to have hyphens between the dd-mmm-yyyy.
// Koa's underlying cookie library just uses .toUTCString() which does not
// output a string with those hyphens
// - Source: https://github.com/pillarjs/cookies/blob/master/lib/cookies.js
// So instead this function returns an object with a .toUTCString() function
// that returns the patched string since that's the only method the cookies.js
// library calls on the value (Date) you provide to the `expires` key.
//
// Usage:
//
//     this.cookies.set('sessionId', session.id, {
//       expires: belt.cookieDate(belt.futureDate({ years: 1 }))
//     });
//
// Update: Don't think I actually need this. Reverted login back from
// using cookieDate. Will get feedback from user having problems.
//
exports.cookieDate = function(date) {
  var padNum = function(n) {
    return n < 10 ? '0' + n : n;
  };

  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var outString = '' +
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] + ', ' +
    padNum(date.getUTCDate()) + '-' +
    months[date.getUTCMonth()] + '-' +
    date.getUTCFullYear() + ' ' +
    padNum(date.getUTCHours()) + ':' +
    padNum(date.getUTCMinutes()) + ':' +
    padNum(date.getUTCSeconds()) + ' GMT';

  return {
    toUTCString: function() { return outString; }
  };
};

// Pretty-/human- version of each role.
//
// Example:
//
//     presentUserRole('conmod') => 'Contest Mod'
//
exports.presentUserRole = function(role) {
  assert(_.isString(role));

  switch(role) {
    case 'conmod':
      return 'Contest Mod';
    default:
      return _.capitalize(role);
  }
};

// Helper function for formatting chat messages for the log.txt
exports.formatChatDate = function(date) {
  var monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];

  return date.getDate() +
    '/' + monthNames[date.getMonth()] +
    '/' + date.getFullYear().toString().slice(2, 4) +
    ' ' +
    _.padLeft(date.getHours().toString(), 2, '0') +
    ':' +
    _.padLeft(date.getMinutes().toString(), 2, '0');
};
