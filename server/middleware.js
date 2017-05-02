"use strict";
// Node
const util = require('util')
// 3rd party
const debug = require('debug')('app:middleware')
const recaptcha = require('recaptcha-validator')
const _ = require('lodash')
const assert = require('better-assert')
// 1st party
const db = require('./db')
const pre = require('./presenters')
const belt = require('./belt')
const config = require('./config')
const bouncer = require('koa-bouncer')

// Assoc ctx.currUser if the sessionId cookie (UUIDv4 String)
// is an active session.
exports.currUser = function () {
  return async (ctx, next) => {
    const sessionId = ctx.cookies.get('sessionId')
    // Skip if no session id
    if (!sessionId) return next()
    // Skip if it's not a uuid
    if (!belt.isValidUuid(sessionId)) return next()

    const user = await db.findUserBySessionId(sessionId)
    ctx.currUser = pre.presentUser(user)
    ctx.state.session_id = sessionId
    return next()
  }
}

// Expose req.flash (getter) and res.flash = _ (setter)
// Flash data persists in user's sessions until the next ~successful response
exports.flash = function (cookieName = 'flash') {
  return async (ctx, next) => {
    let data
    if (ctx.cookies.get(cookieName)) {
      data = JSON.parse(decodeURIComponent(ctx.cookies.get(cookieName)))
    } else {
      data = {}
    }

    Object.defineProperty(ctx, 'flash', {
      enumerable: true,
      get: function () {
        return data
      },
      set: function (val) {
        ctx.cookies.set(cookieName, encodeURIComponent(JSON.stringify(val)))
      }
    })

    await next()

    if (ctx.response.status < 300) {
      ctx.cookies.set(cookieName, null)
    }
  }
}

exports.ensureRecaptcha = async function (ctx, next) {
  if (['development', 'test'].includes(config.NODE_ENV) && !ctx.request.body['g-recaptcha-response']) {
    console.log('Development mode, so skipping recaptcha check')
    return next()
  }

  if (!config.RECAPTCHA_SITEKEY) {
    console.warn('Warn: Recaptcha environment variables not set, so skipping recaptcha check')
    return next()
  }

  ctx.validateBody('g-recaptcha-response')
    .isString('You must attempt the human test')

  try {
    await recaptcha.promise(config.RECAPTCHA_SITESECRET, ctx.vals['g-recaptcha-response'], ctx.request.ip)
  } catch (err) {
    console.warn('Got invalid captcha: ', ctx.vals['g-recaptcha-response'], err)
    ctx.validateBody('g-recaptcha-response')
      .check(false, 'Could not verify recaptcha was correct')
    return
  }

  return next()
}

////////////////////////////////////////////////////////////
// RATELIMITING
////////////////////////////////////////////////////////////

// Int -> Date
function postCountToMaxDate (postCount) {
  assert(Number.isInteger(postCount))
  // prevent double-posts with a min of ~1 second ratelimit
  if (postCount > 10) {
    return new Date(Date.now() - 1000)
  }
  const mins = 5 - (postCount / 2)
  return new Date(Date.now() - mins * 1000 * 60)
}

// Date -> String
//
// 'in 1 minute and 13 seconds'
function waitLength (tilDate) {
  // diff is in seconds
  const diff = Math.max(0, Math.ceil((tilDate - new Date()) / 1000))
  const mins = Math.floor(diff / 60)
  const secs = diff % 60
  let output = ''
  if (mins > 1)
    output += `${mins} minutes and `
  else if (mins === 1)
    output += `${mins} minute and `
  if (secs === 1)
    output += `${secs} second`
  else
    output += `${secs} seconds`
  return output
}

exports.ratelimit = function () {
  return async (ctx, next) => {
    const maxDate = postCountToMaxDate(ctx.currUser.posts_count)
    try {
      await db.ratelimits.bump(ctx.currUser.id, ctx.ip, maxDate)
    } catch (err) {
      if (_.isDate(err)) {
        const msg = `Ratelimited! Since you are a new member, you must wait
          ${waitLength(err)} longer before posting. The ratelimit goes away as you
          make more posts.
        `
        ctx.check(false, msg)
        return
      }
      throw err
    }
    return next()
  }
}

exports.methodOverride = function (
  {bodyKey, headerKey} = {bodyKey: '_method', headerKey: 'x-http-method-override'}
) {
  return async (ctx, next) => {
    if (typeof ctx.request.body === 'undefined') {
      throw new Error('methodOverride middleware must be applied after the body is parsed and ctx.request.body is populated')
    }

    if (ctx.request.body[bodyKey]) {
      ctx.method = ctx.request.body[bodyKey].toUpperCase()
      delete ctx.request.body[bodyKey]
    } else if (ctx.request.headers[headerKey]) {
      ctx.method = ctx.request.headers[headerKey].toUpperCase()
    }

    await next()
  }
}
