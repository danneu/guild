// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var co = require('co');
var RegexTrie = require('regex-trie');
var debug = require('debug')('app:cache');
var assert = require('better-assert');
// 1st party
var db = require('./db');



// TODO: Handle failure
function Cache() {
  this.store = {};
  this.intervals = [];
  var self = this;

  this.get = function(key) {
    var val = self.store[key];
    assert(val);
    return val;
  };

  this.set = function(key, val) {
    self.store[key] = val;
    debug('setting cache key: %s', key);
    return val;
  };

  this.every = function(ms, genFn) {
    // Run the genFn on initial load, and then run it at an interval

    co(genFn.bind(self)).then(succBack, errBack);

    // Initial run successful, so create an interval
    function succBack() {
      var interval = setInterval(function() {
        co(genFn.bind(self)).then(_.noop, errBack);
      }, ms);
      self.intervals.push(interval);
    }

    // genFn failed
    function errBack(err) {
      console.error('Error', err, err.stack);
      throw err;
    }

  };
}

var cache;
module.exports = function() {
  // There can only be one cache instance
  if (cache) return cache;

  cache = new Cache();

  // Every 60 seconds
  cache.every(1000 * 60, function*() {
    this.set('stats', yield db.getStats());
  });

  // Every 5 min
  cache.every(1000 * 60 * 5, function*() {
    var trie = new RegexTrie();
    var unames = yield db.findAllUnames();
    trie.add(unames);
    this.set('uname-regex-trie', trie);
  });

  return cache;
};
