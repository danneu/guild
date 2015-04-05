"use strict";
// 3rd party
var _ = require('lodash');
var assert = require('better-assert');
var debug = require('debug')('app:validation');
var Validator = require('koa-validate').Validator;
// 1st party
var db = require('./db');
var config = require('./config');

////////////////////////////////////////////////////////////
// Util ////////////////////////////////////////////////////
////////////////////////////////////////////////////////////

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
// Custom koa-validate validators //////////////////////////
////////////////////////////////////////////////////////////

// Assert that a string does not match the supplied regular expression.
Validator.prototype.notMatch = function(reg, tip) {
  if (this.goOn && reg.test(this.value)) {
    this.addError(tip || this.key + ' is bad format.');
  }
  return this;
};

// Assert that `assertion`, an arbitrary value, is falsey.
Validator.prototype.assertNot = function(assertion, tip, shouldBail) {
  if (shouldBail) this.goOn = false;
  if (this.goOn && !!assertion) {
    this.addError(tip || this.key + ' failed an assertion.');
  }
  return this;
};

// Assert that `assertion`, an arbitrary value, is truthy.
Validator.prototype.assert = function(assertion, tip, shouldBail) {
  if (shouldBail) this.goOn = false;
  if (this.goOn && !assertion) {
    this.addError(tip || this.key + ' failed an assertion.');
  }
  return this;
};
