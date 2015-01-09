////
//// Fixer functions
////
// "Fixer" functions are used to transform entity attributes to fix
// user mistakes. For example, trailing whitespace and consecutive whitespace
// is usually a mistake. We don't want to trigger validation errors just because
// a user typed "foo " instead of "foo", and it would be silly to force user
// to remove the trailing space when we can do it for them.
// - Returns updated attrs.
// - "Fix" data before passing it into a validator function.

////
//// Validator functions
////
// Validator functions take an `attrs` object and may potentially be a generator
//   if they need to do anything async (like db access)
// Validator should return the fixed attrs so it's ready for db insertion.

// 3rd party
var _ = require('lodash');
var assert = require('better-assert');
var debug = require('debug')('app:validation');
// 1st party
var db = require('./db');

// Util ////////////////////////////////////////////////////

// Collapses 2+ spaces into 1
// Ex: 'a   b   c' -> 'a b c'
function collapseSpaces(str) {
  return str.replace(/\s{2,}/g, ' ');
}

// Removes any whitespace in the string
function removeWhitespace(str) {
  return str.replace(/\s/g, '');
}

////////////////////////////////////////////////////////////

exports.fixNewUser = function(attrs) {
  // Prefix/suffix whitespace in usernames are accidental,
  // but inner whitespace probably isn't, so leave inner whitespace
  // intact so user can see that spaces aren't allowed
  attrs.uname = attrs.uname && attrs.uname.trim();
  // Whitespace in emails are accidental
  attrs.email = attrs.email && removeWhitespace(attrs.email);
  return attrs;
};

exports.validateNewUser = function*(attrs) {
  attrs = exports.fixNewUser(attrs);
  if (! attrs.uname)
    throw 'Username is required';
  if (! /^[a-z0-9_]+$/i.test(attrs.uname))
    throw 'Username contains invalid characters';
  // Ensure underscores are only used as separators, not anything fancier.
  if (/[_]{2,}/i.test(attrs.uname))
    throw 'Username contains consecutive underscores';
  if (/^[_]|[_]$/i.test(attrs.uname))
    throw 'Username starts or ends with underscores';
  if (attrs.uname.length < 2 || attrs.uname.length > 15)
    throw 'Username must be 2-15 characters';
  if (!attrs.email || attrs.email.length < 3)
    throw 'Email is required';
  if (! attrs.password1)
    throw 'Password is required';
  if (attrs.password1.length < 6)
    throw 'Password must be 6 or more characters';
  if (attrs.password1 !== attrs.password2)
    throw 'Password confirmation does not match';

  // Case-insensitive comparison. If 'ace' exists, we don't allow 'Ace'
  if (yield db.findUserByUname(attrs.uname)) {
    throw 'Username is taken';
  };

  if (yield db.findUserByEmail(attrs.email)) {
    throw 'Email is taken';
  };

  // Validation checks out, so return the fixed attrs
  return attrs;
};
