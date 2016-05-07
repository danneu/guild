'use strict';
// 3rd
const debug = require('debug')('app:db:dice');
const assert = require('better-assert');
const knex = require('knex')({
  client: 'pg'
});
const _ = require('lodash');
// 1st
const util = require('./util');

// Note: The db/*.js files are an ongoing effort to
// split apart the db/index.js monolith.

////////////////////////////////////////////////////////////

// Generalized update function that takes an object of
// field/values to be updated.
exports.updateUser = function * (userId, fields) {
  assert(Number.isInteger(userId));
  assert(_.isPlainObject(fields));
  // Validate fields
  const WHITELIST = [
    'gender'
  ];
  Object.keys(fields).forEach(key => {
    if (WHITELIST.indexOf(key) === -1) {
      throw new Error('FIELD_NOT_WHITELISTED');
    }
  });
  // Build SQL string
  const sql = knex('users')
    .where({ id: userId })
    .update(fields)
    .toString();
  return yield util.query(sql);
};
