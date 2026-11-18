// Forum pages: the new-topic form, creating a topic, and the forum's topic
// list. They live outside server/index.ts so tests can mount them without
// booting the app.
// 3rd
import Router from "@koa/router";
import _ from "lodash";
// 1st
import * as config from "../config";
import * as db from "../db";
import * as forumText from "../forum_text";
import * as pre from "../presenters";
import * as belt from "../belt";
import services from "../services";
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
// Create topic
//
// Body params:
// - forum-id
// - title
// - markup
// - tag-ids: Array of StringIntegers (IntChecks/RPs only for now)
// - join-status
//
router.post("/forums/:slug/topics", async (ctx: Context) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 401, "You must be logged in");

  var forumId = belt.extractId(ctx.params.slug);
  ctx.assert(forumId, 404);

  // Load forum
  const loaded = await db.loadForumFor(ctx.currUser, forumId, "plain");
  ctx.assert(loaded.kind === "readable", 404);
  const { forum } = loaded;

  // Check user authorization
  ctx.assertAuthorized(ctx.currUser, "CREATE_TOPIC", forum);

  // Validate params
  ctx
    .validateBody("title")
    .isString("Title is required")
    .trim()
    .isLength(
      config.MIN_TOPIC_TITLE_LENGTH,
      config.MAX_TOPIC_TITLE_LENGTH,
      "Title must be between " +
        config.MIN_TOPIC_TITLE_LENGTH +
        " and " +
        config.MAX_TOPIC_TITLE_LENGTH +
        " chars",
    );
  ctx
    .validateBody("markup")
    .isString("Post is required")
    .trim()
    .isLength(
      config.MIN_POST_LENGTH,
      config.MAX_POST_LENGTH,
      "Post must be between " +
        config.MIN_POST_LENGTH +
        " and " +
        config.MAX_POST_LENGTH +
        " chars",
    );
  ctx.validateBody("forum-id").toInt();

  if (forum.is_roleplay) {
    ctx
      .validateBody("post-type")
      .isIn(["ooc", "ic"], 'post-type must be "ooc" or "ic"');
    ctx
      .validateBody("join-status")
      .isIn(["jump-in", "apply", "full"], "Invalid join-status");
  }

  // Validate tags (only for RPs/Checks
  if (forum.has_tags_enabled) {
    ctx
      .validateBody("tag-ids")
      .toArray()
      .toInts()
      .tap((ids) => {
        // One of them will be -1
        return ids.filter((n) => n > 0);
      })
      .isLength(1, 7, "Must select 1-7 tags");
  }
  ctx.validateBody("tag-ids").defaultTo([]);

  // Validation succeeded

  // post-type is always ooc for non-RPs
  var postType = forum.is_roleplay ? ctx.vals["post-type"] : "ooc";

  var tagIds = _.chain(ctx.vals["tag-ids"])
    .concat(forum.tag_id ? [forum.tag_id] : [])
    .uniq()
    .value();

  // Create topic. It waits for the spam verdict, so a suspected spammer's
  // topic is flagged.
  const created = await forumText.createTopic(ctx.currUser, {
    forumId: forumId,
    ipAddress: ctx.request.ip,
    title: ctx.vals.title,
    markup: ctx.vals.markup,
    postType: postType,
    isRoleplay: forum.is_roleplay,
    tagIds: tagIds,
    joinStatus: ctx.vals["join-status"],
  });
  const topic = pre.presentTopic(created.topic);

  ctx.response.redirect(topic.url);

  // Welcome an Introduce Yourself topic in #general, unless it tripped the
  // spam detector. relayOnce welcomes each member once.
  if (!created.flagged && topic.forum_id === 2) {
    services.discord
      .relayOnce("intro", ctx.currUser, { topicUrl: topic.url })
      .catch((err) => console.error("intro relay failed", err));
  }
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
