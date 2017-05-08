
// 3rd
const Router = require('koa-router')
// 1st
const db = require('../db')
const pre = require('../presenters')

const router = new Router()

////////////////////////////////////////////////////////////

// Only admin and smod can manage tags
router.use(async (ctx, next) => {
  ctx.assert(ctx.currUser, 404)
  ctx.assert(['smod', 'admin'].includes(ctx.currUser.role), 404)
  return next()
})

////////////////////////////////////////////////////////////

router.get('/tag-groups', async (ctx) => {
  const groups = (await db.tags.listGroups())
    .map(pre.presentTagGroup)

  await ctx.render('tags/list_tag_groups', {
    ctx,
    groups
  })
})

////////////////////////////////////////////////////////////

// Create tag group
//
// body: { title: String }
router.post('/tag-groups', async (ctx) => {
  ctx.validateBody('title')
    .isString()
    .isLength(1, 32)

  const group = await db.tags.insertTagGroup(ctx.vals.title)

  ctx.flash = { message: ['success', 'Tag group created'] }
  ctx.redirect('/tag-groups')
})

////////////////////////////////////////////////////////////

// Insert tag
//
router.post('/tag-groups/:id/tags', async (ctx) => {
  ctx.validateParam('id').toInt()

  const group = await db.tags.getGroup(ctx.vals.id)
  ctx.assert(group, 404)

  ctx.validateBody('title')
    .isString()
    .tap((s) => s.trim())
    .isLength(1, 30)
  ctx.validateBody('desc')
    .optional()
    .isString()
    .tap((s) => s.trim())
    .isLength(1, 140)

  const tag = await db.tags.insertTag(group.id, ctx.vals.title, ctx.vals.desc)

  ctx.flash = { message: ['success', 'Tag created'] }
  ctx.redirect('/tag-groups')
})

////////////////////////////////////////////////////////////

module.exports = router
