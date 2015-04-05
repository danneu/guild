"use strict";
// Node deps
var path = require('path');
var fs = require('co-fs');
// 3rd party
var pg = require('co-pg')(require('pg'));
var co = require('co');
var _ = require('lodash');
var coParallel = require('co-parallel');
// 1st party
var db = require('./db');
var config = require('./config');

////////////////////////////////////////////////////////////

function* slurpSql(filePath) {
  var relativePath = '../sql/' + filePath;
  var fullPath = path.join(__dirname, relativePath);
  return yield fs.readFile(fullPath, 'utf8');
}

function* resetDb() {
  // Create tables
  var sql = yield slurpSql('schema.sql');
  yield db.query(sql);
  console.log('Reset schema.sql');
  // Link up triggers
  sql = yield slurpSql('functions_and_triggers.sql');
  yield db.query(sql);
  console.log('Reset functions_and_triggers.sql');
  if (config.NODE_ENV === 'development') {
    sql = yield slurpSql('dev_seeds.sql');
    yield db.query(sql);
    console.log('Inserted dev_seeds.sql');

    // Insert 100 topics for forum1
    var thunks;
    thunks = _.range(100).map(function(n) {
      var markup = 'Post ' + n;
      return db.createTopic({
        userId: 1, forumId: 1, ipAddress: '1.2.3.4',
        title: 'My topic ' + n,
        markup: markup, html: markup,
        isRoleplay: false, postType: 'ooc'
      });
    });
    yield coParallel(thunks, 1);

    // Insert 100 posts for user1, forum1
    thunks = _.range(100).map(function(n) {
      var markup = n.toString();
      return db.createPost({
        userId: 1, ipAddress: '1.2.3.4',
        markup: markup, html: markup,
        topicId: 1, isRoleplay: false,
        type: 'ooc'
      });
    });
    yield coParallel(thunks, 1);
  }
}

if (!module.parent) {
  // Called from cli
  var succBack = function() {
    console.log('Database reset!');
    process.exit();
  };
  var errBack = function(err) {
    console.error('Caught error: ', err, err.stack);
  };
  co(function*() {
    console.log('Resetting the database...');
    yield resetDb();
  }).then(succBack, errBack);
} else {
  // Loaded by a script
  module.exports = resetDb;
}
