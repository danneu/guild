
// 3rd
const assert = require('better-assert')
// 1st
const belt = require('../../belt')
const akismet = require('../../akismet')

// Returns SPAM | NOT_SPAM | API_TIMEOUT | API_ERROR
// Only SPAM should result in a nuke
async function analyze (ctx, markup) {
  assert(ctx.currUser)
  assert(typeof markup === 'string')

  return await Promise.race([
    belt.timeout(10000).then(() => 'API_TIMEOUT'),
    akismet.checkComment({
      commentType: 'reply',
      commentAuthor: ctx.currUser.uname,
      commentEmail: ctx.currUser.email,
      commentContent: markup,
      userIp: ctx.ip,
      userAgent: ctx.headers['user-agent']
    }).then((isSpam) => isSpam ? 'SPAM' : 'NOT_SPAM')
  ]).catch((err) => {
    // On error, just let them post
    console.error('akismet error', err)
    return 'API_ERROR'
  })
}

module.exports = {
  analyze
}
