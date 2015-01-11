// 3rd party
var bunyan = require('bunyan');
var _ = require('lodash');
// 1st party
var belt = require('./belt');
var config = require('./config');

var log = bunyan.createLogger({
  name: 'guild',
  streams: [
    { level: 'info', stream: process.stdout },
    { level: 'error', stream: process.stderr },
    { level: 'fatal', stream: process.stderr }
  ],
  serializers: {
    req: function(req) {
      var o = {
        method: req.method,
        url: req.url,
      };
      if (!_.isEmpty(req.body))
        o.body = belt.truncateStringVals(req.body);
      return o;
    },
    res: function(res) {
      return { status: res.status };
    },
    err: bunyan.stdSerializers.err,
    convo: function(convo) {
      return {
        id: convo.id,
        title: convo.title,
      };
    },
    topic: function(topic) {
      return {
        id: topic.id,
        title: topic.title,
        is_roleplay: topic.is_roleplay
      };
    },
    session: function(session) {
      return {
        id: session.id,
        created_at: session.created_at,
        expired_at: session.expired_at,
      };
    },
    resetToken: function(resetToken) {
      return {
        user_id: resetToken.user_id,
        token: resetToken.token
      };
    },
    pm: function(pm) {
      return {
        id: pm.id,
        convo_id: pm.convo_id,
        text: belt.truncate(pm.text, 100)
      };
    },
    post: function(post) {
      return {
        id: post.id,
        type: post.type,
        topic_id: post.topic_id,
        text: belt.truncate(post.text, 100),
        text_length: post.text.length,
        is_roleplay: post.is_roleplay
      };
    },
    currUser: function(user) {
      return {
        id: user.id,
        uname: user.uname
      };
    }
  }
});

// In development, show the file, line, and fn name that
// logged each row of log output. It's expensive and should not
// be used in production.
if (config.NODE_ENV === 'development')
  log.src = true;

module.exports = log;
