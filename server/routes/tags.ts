// 3rd
import Router, { RouterContext } from "@koa/router";
// 1st
import * as db from "../db";
import * as pre from "../presenters";
import { Context, Next } from "koa";
import z from "zod";

const router = new Router();

////////////////////////////////////////////////////////////

// Only admin can manage tags until I improve the form
router.use(async (ctx: RouterContext, next: Next) => {
  ctx.assert(ctx.currUser, 404);
  ctx.assert(ctx.currUser.role === "admin", 404);
  return next();
});

////////////////////////////////////////////////////////////

router.get("/tag-groups", async (ctx: Context) => {
  const groups = (await db.tags.listGroups()).map(pre.presentTagGroup);

  await ctx.render("tags/list_tag_groups", {
    ctx,
    groups,
  });
});

////////////////////////////////////////////////////////////

// Create tag group
//
// body: { title: String }
router.post("/tag-groups", async (ctx: Context) => {
  const BodySchema = z.object({
    title: z.string().trim().min(1).max(32),
  });
  const body = BodySchema.parse(ctx.request.body);

  await db.tags.insertTagGroup(body.title);

  ctx.flash = { message: ["success", "Tag group created"] };
  ctx.redirect("/tag-groups");
});

////////////////////////////////////////////////////////////

// Insert tag
//
router.post("/tag-groups/:id/tags", async (ctx: Context) => {
  const ParamsSchema = z.object({
    id: z.coerce.number().int(),
  });
  const params = ParamsSchema.parse(ctx.params);

  const group = await db.tags.getGroup(params.id);
  ctx.assert(group, 404);

  const BodySchema = z.object({
    title: z.string().trim().min(1).max(30),
    desc: z.string().trim().min(1).max(140).optional(),
    // letters, hyphens, numbers
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/),
  });
  const body = BodySchema.parse(ctx.request.body);

  const _tag = await db.tags.insertTag({
    groupId: group.id,
    title: body.title,
    slug: body.slug,
    desc: body.desc,
  });
  void _tag;

  ctx.flash = { message: ["success", "Tag created"] };
  ctx.redirect("/tag-groups");
});

////////////////////////////////////////////////////////////

// Body { tag_group_id: Int }
router.post("/tags/:id/move", async (ctx: Context) => {
  const ParamsSchema = z.object({
    id: z.coerce.number().int(),
  });
  const params = ParamsSchema.parse(ctx.params);
  const tag = await db.tags.getTag(params.id);
  ctx.assert(tag, 404);

  const BodySchema = z.object({
    tag_group_id: z.coerce.number().int(),
  });
  const body = BodySchema.parse(ctx.request.body);

  const newGroup = await db.tags.getGroup(body.tag_group_id);

  if (!newGroup) {
    ctx.flash = { message: ["danger", "No tag group found with that ID"] };
    ctx.redirect("/tag-groups");
    return;
  }

  await db.tags.moveTag({ tagId: tag.id, toGroupId: newGroup.id });

  ctx.flash = { message: ["success", "Tag moved"] };
  ctx.redirect("/tag-groups");
});

////////////////////////////////////////////////////////////

export default router;
