// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var co = require('co');
// 1st party
var db = require('./db');

// Handle failure

function Cache(log) {
  this.log = log;
  this.store = {};
  this.intervals = [];
  var self = this;

  this.get = function(key) {
    self.log.info({ key: key }, 'Fetching from cache[%s]');
    return self.store[key];
  };

  this.set = function(key, val) {
    self.log.info({ key: key }, 'Updating cache[%s]', key);
    self.store[key] = val;
    return val;
  };

  this.every = function(ms, genFn) {
    // Run the genFn on initial load, and then run it at an interval
    co(function*() {
      var result = yield genFn.bind(self)();
    }).then(succBack, errBack);

    // Initial run successful, so create an interval
    function succBack() {
      var interval = setInterval(function() {
        co(function*() {
          yield genFn.bind(self)();
        }).then(_.noop, errBack);
      }, ms);
      self.intervals.push(interval);
    }

    // genFn failed
    function errBack(err) {
      self.log.fatal(err);
    }

  };
}

module.exports = function(log) {
  var cache = new Cache(log);

  // Every 60 seconds
  cache.every(1000 * 60, function*() {
    var stats = this.set('stats', yield db.getStats());
  });

  return cache;
};
