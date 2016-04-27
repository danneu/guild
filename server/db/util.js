'use strict';
// 3rd
const assert = require('better-assert');
const pg = require('co-pg')(require('pg'));
const _ = require('lodash');
const uuid = require('node-uuid');
const debug = require('debug')('app:db');
// 1st
const config = require('../config');
const belt = require('../belt');

/*

   This file comes with the core reusable database functions.

   They were extracted from db/index.js

   TODO: Update db/index.js to use this module,
         and remove all those dead functions

*/

// parse int8 as an integer
// TODO: Handle numbers past parseInt range
pg.types.setTypeParser(20, val => val === null ? null : parseInt(val));
// parse numeric
pg.types.setTypeParser(1700, val => val === null ? null : parseFloat(val));

////////////////////////////////////////////////////////////
// Core helper functions
////////////////////////////////////////////////////////////

// Run query with pooled connection
exports.query = query;
function* query(sql, params) {
  const connResult = yield pg.connectPromise(config.DATABASE_URL);
  const client = connResult[0];
  const done = connResult[1];
  try {
    return yield client.queryPromise(sql, params);
  } finally {
    // Release client back to pool even upon query error
    done();
  }
}

exports.queryOne = queryOne;
function* queryOne(sql, params) {
  const result = yield query(sql, params);
  assert(result.rows.length <= 1);
  return result.rows[0];
}

exports.queryMany = queryMany;
function* queryMany(sql, params) {
  const result = yield query(sql, params);
  return result.rows;
}

// Add those queryOne and queryMany helpers to the pg Client prototype
// too so that we can use them inside transactions and such.
//
// Example:
//
//    exports.testQuery = function*() {
//      return yield withTransaction(function*(client) {
//        var count1 = yield client.queryOnePromise('SELECT COUNT(*) FROM users');
//        var count2 = yield client.queryOnePromise('SELECT COUNT(*) FROM messages');
//
//        return [count1, count2];
//      });
//    };
pg.Client.prototype.queryOnePromise = function(sql, params) {
  return this.queryPromise(sql, params).then(result => result.rows[0]);
};

pg.Client.prototype.queryManyPromise = function(sql, params) {
  return this.queryPromise(sql, params).then(result => result.rows);
};

// `runner` is a generator function that accepts one arguement:
// a database client. Note in deadlocks, runner is called *multiple times*
exports.withClient = withClient;
function* withClient(runner) {
  const connResult = yield pg.connectPromise(config.DATABASE_URL);
  const client = connResult[0];
  const done = connResult[1];

  let result;
  try {
    result = yield runner(client);
  } catch (err) {
    if (err.removeFromPool) {
      err.human = 'Could not remove from pool';
      done(new Error('Removing connection from pool'));
      throw err;
    } else if (err.code === '40P01') { // Deadlock
      done();
      return yield withClient(runner);
    } else if (err.code === '40001') { // Serialization failure
      done();
      return yield withClient(runner);
    } else {
      done();
      throw err;
    }
  }

  done();
  return result;
}

// TODO: I think this has a deadlock bug

// `runner` is a generator function that accepts one arguement:
// a database client.  Note in deadlocks, runner is called *multiple times*
exports.withTransaction = withTransaction;
function* withTransaction(runner) {
  return yield withClient(function*(client) {
    let result;
    try {
      yield client.queryPromise('BEGIN');
      result = yield runner(client);
      yield client.queryPromise('COMMIT');
      return result;
    } catch (err) {
      try {
        yield client.queryPromise('ROLLBACK');
      } catch(err) {
        err.removeFromPool = true;
        throw err;
      }
      throw err;
    }
  });
}
