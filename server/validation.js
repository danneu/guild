"use strict";
// 3rd party
var _ = require('lodash');
var assert = require('better-assert');
var debug = require('debug')('app:validation');
var Validator = require('koa-bouncer').Validator;
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

Validator.addMethod('notEq', function (otherVal, tip) {
  this.checkPred((val) => val !== otherVal, tip);
  return this
})
