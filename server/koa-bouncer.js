// 3rd party
var _ = require('lodash');
var debug = require('debug')('bouncer');

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

Validator.prototype.toInt = function(tip) {
  var result = parseInt(this.value, 10);
  if (_.isNaN(result))
    this.throwError(tip || this.key + ' must be an integer');
  this.valid[this.key] = this.state[this.type][this.key] = this.value = result;
  return this;
};

Validator.prototype.toBoolean = function() {
  this.valid[this.key] = this.state[this.type][this.key] = this.value = !!this.value;
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
          value: self.query[key],
          state: self.bouncer,
          type: 'query',
          valid: self.valid
        });
      };
      this.bouncer.checkBody = this.validateBody = function(key) {
        return new Validator({
          key: key,
          value: self.request.body[key],
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
