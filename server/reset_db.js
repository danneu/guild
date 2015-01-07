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
  // Link up triggers
  sql = yield slurpSql('functions_and_triggers.sql');
  yield db.query(sql);
  if (false && config.NODE_ENV === 'development') {
    sql = yield slurpSql('dev_seeds.sql');
    yield db.query(sql);

    // Insert 100 topics for forum1
    var thunks = _.range(100).map(function(n) {
      return db.createTopic({
        userId: 1, forumId: 1, ipAddress: '1.2.3.4',
        title: 'My topic ' + n, text: 'Post ' + n,
        isRoleplay: false, postType: 'ooc'
      });
    });
    yield coParallel(thunks, 2);

    // Insert 100 posts for user1, forum1 (in parallel)
    yield _.range(100).map(function(n) {
      return db.createPost({
        userId: 1, ipAddress: '1.2.3.4',
        text: n.toString(), topicId: 1, isRoleplay: false,
        type: 'ooc'
      });
    });
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
