// Node
var util = require('util');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('bouncer');
var assert = require('better-assert');

function ValidationError(key, message) {
  this.name = 'ValidationError';
  this.message = message;
  this.bouncer = { key: key };
}
ValidationError.prototype = _.create(Error.prototype);

function Validator(props) {
  this.key = props.key;
  this.value = props.value;
  this.state = props.state;
  this.type = props.type;
  this.valid = props.valid;
  this.throwError = function(tip) {
    throw new ValidationError(this.key, tip);
  };
}

Validator.prototype.isNotEmpty = function(tip) {
  if (_.isEmpty(this.value))
    this.throwError(tip || this.key + ' must not be empty');
  this.valid[this.key] = this.state[this.type][this.key] = this.value;
  return this;
};

Validator.prototype.isIn = function(arr, tip) {
  if (!_.contains(arr, this.value))
    this.throwError(tip || 'Invalid ' + this.key);
  this.valid[this.key] = this.state[this.type][this.key] = this.value;
  return this;
};

Validator.prototype.isArray = function(tip) {
  if (!_.isArray(this.value))
    this.throwError(tip || util.format('%s must be an array', this.key));
  this.valid[this.key] = this.value;
  return this;
};

Validator.prototype.isLength = function(min, max, tip) {
  debug('[isLength] this.value: %j', this.value);
  assert(min);
  assert(max);
  assert(_.isFinite(this.value.length));
  if (this.value.length < min || this.value.length > max)
    this.throwError(
      tip || util.format('%s must be %s-%s characters long', this.key, min, max)
    );
  this.valid[this.key] = this.value;
  return this;
};

Validator.prototype.default = function(v) {
  debug('[default] this.value: %j', this.value);
  this.valid[this.key] = this.value = _.isUndefined(this.value) ? v : this.value;
  return this;
};

Validator.prototype.toInt = function(tip) {
  var result = parseInt(this.value, 10);
  if (_.isNaN(result))
    this.throwError(tip || this.key + ' must be an integer');
  this.valid[this.key] = this.state[this.type][this.key] = this.value = result;
  return this;
};

// If value is not already an array, puts it in a singleton array
Validator.prototype.toArray = function(tip) {
  this.value = _.isUndefined(this.value) ? [] : this.value;
  this.valid[this.key] = this.value =
    (_.isArray(this.value) ? this.value : [this.value]);
  return this;
};

Validator.prototype.toInts = function(tip) {
  debug('[toInts] this.value: %j', this.value);
  this.toArray();
  var results = this.value.map(function(v) {
    return parseInt(v, 10);
  });
  debug(results);

  if (!_.every(results, _.isFinite))
    this.throwError(tip || this.key + ' must be an array of integers');

  this.valid[this.key] = this.value = results;
  debug('69 %j', this.value);
  return this;
};

// FIXME: I don't think this is necessary. I doubt foo=42&foo=42 will get
// parsed into an array with dupe values, but I'm not yet sure enough to remove.
Validator.prototype.uniq = function(tip) {
  this.toArray();
  this.valid[this.key] = this.value = _.uniq(this.value);
  return this;
};

Validator.prototype.toBoolean = function() {
  this.valid[this.key] = this.state[this.type][this.key] = this.value = !!this.value;
  return this;
};

Validator.prototype.toLowerCase = function() {
  this.valid[this.key] = this.value = (this.value || '').toLowerCase();
  return this;
};

Validator.prototype.toUpperCase = function() {
  this.valid[this.key] = this.value = (this.value || '').toUpperCase();
  return this;
};

Validator.prototype.check = function(result, tip) {
  if (!result)
    this.throwError(tip);
  return this;
};

Validator.prototype.checkNot = function(result, tip) {
  if (!!result)
    this.throwError(tip);
  return this;
};

module.exports = {
  ValidationError: ValidationError,
  middleware: function() {
    return function*(next) {
      debug('Initializing koa-bouncer');
      var self = this;
      this.valid = {};
      this.bouncer = {
        // Map of paramName -> errString
        errors: {},
        body: {},
        query: {}
      };
      this.bouncer.checkQuery = this.validateQuery = function(key) {
        return new Validator({
          key: key,
          // Use existing this.valid value if there is one
          value: self.valid[key] || self.query[key],
          state: self.bouncer,
          type: 'query',
          valid: self.valid
        });
      };
      this.bouncer.checkBody = this.validateBody = function(key) {
        return new Validator({
          key: key,
          // Use existing this.valid value if there is one
          value: self.valid[key] || self.request.body[key],
          state: self.bouncer,
          type: 'body',
          valid: self.valid
        });
      };
      this.bouncer.check = this.validate = function(result, tip) {
        debug('[check] result: %j, tip: %s', result, tip);
        if (!result)
          throw new ValidationError('', tip);
      };
      yield next;
    };
  }
};
