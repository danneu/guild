"use strict";
// 3rd party
const nodemailer = require('nodemailer');
const ses = require('nodemailer-ses-transport');
const assert = require('better-assert');
const _ = require('lodash');
const nunjucks = require('nunjucks');
const debug = require('debug')('app:emailer');
// 1st party
const belt = require('./belt');
const config = require('./config');

function getTransporter() {
  assert(config.AWS_KEY, 'AWS_KEY must be set to send emails');
  assert(config.AWS_SECRET, 'AWS_SECRET must be set to send emails');
  const transporter = nodemailer.createTransport(ses({
    accessKeyId: config.AWS_KEY,
    secretAccessKey: config.AWS_SECRET
  }));
  return transporter;
}

var templates = {
  resetToken: nunjucks.compile(`
<p>Hello {{ uname }},</p>

<p>This link will take you to a form that will let you type in a new password:</p>

<a href='{{ host }}/reset-password?token={{ token }}'>
  {{ host }}/reset-password?token={{ token }}
</a>

<p>If you did not expect this email, you can ignore it and nothing will happen.</p>
  `)
};

exports.sendResetTokenEmail = function(toUname, toEmail, token) {
  debug('[sendResetTokenEmail]');
  assert(config.FROM_EMAIL, 'FROM_EMAIL must be set to send emails');
  assert(config.HOST, 'HOST must be set to send emails');
  assert(_.isString(toUname));
  assert(_.isString(toEmail));
  assert(belt.isValidUuid(token));
  var transporter = getTransporter();
  //var result = yield transporter._sendMailPromise({
  var result = transporter.sendMail({
    from: config.FROM_EMAIL,
    to: toEmail,
    subject: 'Password Reset Token - RoleplayerGuild.com',
    html: templates.resetToken.render({
      uname: toUname,
      host: config.HOST,
      token: token
    })
  }, function(err, info) {
    // TODO: Log errors in background.
    // Since we don't expose to user if they entered a valid email,
    // we can't really do anything upon email failure.
    debug('Tried sending email from <%s> to <%s>', config.FROM_EMAIL, toEmail);
    if (err) return console.error(err);
    console.log(info);
  });
};
