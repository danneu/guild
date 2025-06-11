'use strict'
// 3rd party
const nodemailer = require('nodemailer')
const ses = require('nodemailer-ses-transport')
const { assert } = require('./util')
const _ = require('lodash')
const nunjucks = require('nunjucks')
const debug = require('debug')('app:emailer')
// 1st party
const belt = require('./belt')
const config = require('./config')

function getTransporter() {
    assert(config.AWS_KEY, 'AWS_KEY must be set to send emails')
    assert(config.AWS_SECRET, 'AWS_SECRET must be set to send emails')
    const transporter = nodemailer.createTransport(
        ses({
            accessKeyId: config.AWS_KEY,
            secretAccessKey: config.AWS_SECRET,
        })
    )
    return transporter
}

var templates = {
    resetToken: nunjucks.compile(`
<p>Hello {{ uname }},</p>

<p>This link will take you to a form that will let you type in a new password:</p>

<a href='{{ host }}/reset-password?token={{ token }}'>
  {{ host }}/reset-password?token={{ token }}
</a>

<p>If you did not expect this email, you can ignore it and nothing will happen.</p>
  `),
}

const FROM = 'Mahz <mahz@roleplayerguild.com>'

exports.sendResetTokenEmail = function(toUname, toEmail, token) {
    debug('[sendResetTokenEmail]')
    assert(config.HOST, 'HOST must be set to send emails')
    assert(_.isString(toUname))
    assert(_.isString(toEmail))
    assert(belt.isValidUuid(token))
    var transporter = getTransporter()
    //var result = yield transporter._sendMailPromise({
    return getTransporter()
        .sendMail({
            from: FROM,
            to: toEmail,
            subject: 'Password Reset Token - RoleplayerGuild.com',
            html: templates.resetToken.render({
                uname: toUname,
                host: config.HOST,
                token: token,
            }),
        })
        .catch(err => {
            console.error(`Failed to send reset token email to ${toUname}`, err)
            throw err
        })
}

// Return promise
exports.sendAutoNukeEmail = (() => {
    const template = nunjucks.compile(`
    <p>
      Akismet detected spammer:
      <a href="${config.HOST}/users/{{ slug }}">{{ slug }}</a>
    </p>
    <blockquote>
      {{ markup }}
    </blockquote>
  `)

    return (slug, markup) => {
        assert(config.HOST, 'HOST must be set to send emails')

        return getTransporter()
            .sendMail({
                from: FROM,
                to: 'danrodneu@gmail.com',
                subject: `Guild Auto-Nuke: ${slug}`,
                html: template.render({ slug, markup }),
            })
            .catch(err => {
                console.error(`Failed to send auto-nuke email`, err)
                throw err
            })
    }
})()
