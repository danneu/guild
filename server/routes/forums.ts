// Forum pages: the new-topic form and the forum's topic list. They live
// outside server/index.ts so tests can mount them without booting the app.
// 3rd
import Router from "@koa/router";
import _ from "lodash";
// 1st
import * as db from "../db";
import * as pre from "../presenters";
import * as belt from "../belt";
import { Context } from "koa";

////////////////////////////////////////////////////////////

const router = new Router();

////////////////////////////////////////////////////////////

//
// New topic form
//
router.get("/forums/:forumSlug/topics/new", async (ctx: Context) => {
  // Load forum
  var forumId = belt.extractId(ctx.params.forumSlug);
  ctx.assert(forumId, 404);
  const loaded = await db.loadForumFor(ctx.currUser, forumId, "plain");
  ctx.assert(loaded.kind === "readable", 404);
  const { forum } = loaded;

  // Ensure user authorized to create topic in this forum
  ctx.assertAuthorized(ctx.currUser, "CREATE_TOPIC", forum);

  // Get tag groups
  var tagGroups = forum.has_tags_enabled ? await db.findAllTagGroups() : [];

  var toArray = function (stringOrArray) {
    return _.isArray(stringOrArray) ? stringOrArray : [stringOrArray];
  };

  // Render template
  await ctx.render("new_topic", {
    ctx,
    forum: forum,
    tagGroups: tagGroups,
    postType: (ctx.flash.params && ctx.flash.params["post-type"]) || "ooc",
    initTitle: ctx.flash.params && ctx.flash.params.title,
    selectedTagIds:
      (ctx.flash.params &&
        toArray(ctx.flash.params["tag-ids"]).map(function (idStr) {
          return parseInt(idStr);
        })) ||
      [],
  });
});

//
// Canonical show forum
//
// This router is mounted before the one in server/index.ts, so this route
// shadows any GET /forums/<word> registered there.
//
// @koa2
router.get("/forums/:forumSlug", async (ctx: Context) => {
  const forumId = belt.extractId(ctx.params.forumSlug);
  ctx.assert(forumId, 404);

  ctx.validateQuery("page").optional().toInt();

  const loaded = await db.loadForumFor(ctx.currUser, forumId, "with-family");
  ctx.assert(loaded.kind === "readable", 404);
  const { forum } = loaded;

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(forum.id, forum.title);
  if (ctx.params.forumSlug !== expectedSlug) {
    ctx.status = 301;
    ctx.response.redirect(forum.url + ctx.request.search);
    return;
  }

  // forum.topics_count also counts hidden topics, so a member's last pages
  // can come up short or empty. The homepage shows the same count.
  var pager = belt.calcPager(ctx.vals.page, 25, forum.topics_count);

  const [viewers, topics] = await Promise.all([
    db.findViewersForForumId(forum.id),
    db.findTopicsByForumId(ctx.currUser, forum.id, pager.limit, pager.offset),
  ]);

  forum.topics = topics;
  pre.presentForum(forum);

  const tabbedForums = [
    forum.parent_forum,
    ...forum.sibling_forums,
    ...forum.child_forums,
  ].filter(Boolean);

  // update viewers in background
  db.upsertViewer(ctx, forum.id).catch(console.error);

  await ctx.render("show_forum", {
    ctx,
    forum,
    tabbedForums,
    currPage: pager.currPage,
    totalPages: pager.totalPages,
    title: forum.title,
    className: "show-forum",
    // Viewers
    viewers,
  });
});

////////////////////////////////////////////////////////////

export default router;
