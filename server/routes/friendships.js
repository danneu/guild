
// Node
const nodeUrl = require('url')
// 3rd
const Router = require('koa-router')
// 1st
const db = require('../db')
const pre = require('../presenters')

const router = new Router()

////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////
// Friendships
// - to_user_id Int
// - commit: Required 'add' | 'remove'
//
// Optionally pass a redirect-to (URI encoded)
router.post('/me/friendships', async (ctx) => {
  // ensure user logged in
  ctx.assert(ctx.currUser, 404)
  ctx.assert(ctx.currUser.role !== 'banned', 404)

  // validate body
  ctx.validateBody('commit').isIn(['add', 'remove'])
  ctx.validateBody('to_user_id').toInt()

  const nodeUrl = require('url')

  let redirectTo;
  if (ctx.query['redirect-to']) {
    const parsed = nodeUrl.parse(decodeURIComponent(ctx.query['redirect-to']))
    redirectTo = parsed.pathname
  }

  // update db
  if (ctx.vals.commit === 'add') {
    await db.createFriendship(ctx.currUser.id, ctx.vals.to_user_id)
    ctx.flash = { message: ['success', 'Friendship added'] }
  } else {
    await db.deleteFriendship(ctx.currUser.id, ctx.vals.to_user_id)
    ctx.flash = { message: ['success', 'Friendship removed'] }
  }

  // redirect
  ctx.redirect(redirectTo || '/users/' + ctx.vals.to_user_id)
})

////////////////////////////////////////////////////////////

router.get('/me/friendships', async (ctx) => {
  // ensure user logged in
  ctx.assert(ctx.currUser, 404)
  ctx.assert(ctx.currUser.role !== 'banned', 404)

  // load friendships
  const friendships = await db.findFriendshipsForUserId(ctx.currUser.id)
    .then((xs) => xs.map(pre.presentFriendship))

  // render
  await ctx.render('me_friendships', {
    ctx,
    friendships,
    title: 'My Friendships'
  })
})

////////////////////////////////////////////////////////////

module.exports = router
