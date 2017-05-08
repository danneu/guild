
// 3rd
const Router = require('koa-router')
// 1st
const db = require('../db')
const pre = require('../presenters')

const router = new Router()

////////////////////////////////////////////////////////////

// Only admin can manage tags until I improve the form
router.use(async (ctx, next) => {
  ctx.assert(ctx.currUser, 404)
  ctx.assert(ctx.currUser.role === 'admin', 404)
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

// Body { tag_group_id: Int }
router.post('/tags/:id/move', async (ctx) => {
  ctx.validateParam('id').toInt()

  const tag = await db.tags.getTag(ctx.vals.id)
  ctx.assert(tag, 404)

  ctx.validateBody('tag_group_id').toInt()
  const newGroup = await db.tags.getGroup(ctx.vals.tag_group_id)

  if (!newGroup) {
    ctx.flash = { message: ['danger', 'No tag group found with that ID'] }
    ctx.redirect('/tag-groups')
    return
  }

  await db.tags.moveTag(tag.id, newGroup.id)

  ctx.flash = { message: ['success', 'Tag moved'] }
  ctx.redirect('/tag-groups')
})

////////////////////////////////////////////////////////////

module.exports = router
