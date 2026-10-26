// Node
import util from "util";
// 3rd
import Router from "@koa/router";
import bouncer from "koa-bouncer";
// import createDebug from 'debug'
// const debug = createDebug('app:routes:topics')
// 1st
import * as db from "../db";
import * as pre from "../presenters";
import * as config from "../config";
import * as belt from "../belt";
import * as cancan from "../cancan";
import * as middleware from "../middleware";
import bbcode from "../bbcode";
import cache3 from "../cache3";
import services from "../services";
import { Context } from "koa";
import { pool, withPgPoolTransaction } from "../db/util";
import z from "zod";

////////////////////////////////////////////////////////////

const router = new Router();

////////////////////////////////////////////////////////////

// Create the tab's 0th post
//
// Body:
// - markup
router.post("/topics/:topicId/:postType/0th", async (ctx: Context) => {
  console.log("params is", ctx.params);
  const ParamsSchema = z.object({
    topicId: z.string().transform((val) => parseInt(val, 10)),
    postType: z.enum(["ic", "ooc", "char"]),
  });
  const params = ParamsSchema.parse(ctx.params);
  ctx.assert(Number.isInteger(params.topicId), 404);

  const loaded = await db.loadTopicFor(ctx.currUser, params.topicId, "full");
  ctx.assert(loaded.kind === "readable", 404);
  const { topic } = loaded;

  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC", topic);

  const BodySchema = z.object({
    markup: z
      .string({ message: "Post is required" })
      .trim()
      .min(config.MIN_POST_LENGTH, {
        message: `Post must be at least ${config.MIN_POST_LENGTH} chars`,
      })
      .max(config.MAX_POST_LENGTH, {
        message: `Post must be at most ${config.MAX_POST_LENGTH} chars`,
      }),
  });
  const body = BodySchema.parse(ctx.request.body);

  const redirectTo = `${topic.url}/${params.postType}`;

  await withPgPoolTransaction(pool, async (pgClient) => {
    await db
      .createPost(pgClient, {
        userId: ctx.currUser.id,
        ipAddress: ctx.ip,
        markup: body.markup,
        html: bbcode(body.markup),
        topicId: topic.id,
        isRoleplay: true,
        type: params.postType,
        idx: -1,
      })
      .catch((err) => {
        if (err instanceof Error && "code" in err && err.code === "23505") {
          ctx.flash = {
            message: ["danger", `0th post for this tab already exists.`],
          };
          ctx.redirect(redirectTo);
          return;
        }
        throw err;
      });
  });

  ctx.flash = {
    message: ["success", `Created 0th post for ${params.postType} tab`],
  };
  ctx.redirect(redirectTo);
});

////////////////////////////////////////////////////////////

// Create post
// Body params:
// - post-type
// - markup
//
router.post(
  "/topics/:topicSlug/posts",
  middleware.ratelimit(),
  async (ctx: Context) => {
    var topicId = belt.extractId(ctx.params.topicSlug);
    ctx.assert(topicId, 404);

    ctx
      .validateBody("post-type")
      .isIn(["ic", "ooc", "char"], "Invalid post-type");
    ctx
      .validateBody("markup")
      .isLength(
        config.MIN_POST_LENGTH,
        config.MAX_POST_LENGTH,
        "Post must be between " +
          config.MIN_POST_LENGTH +
          " and " +
          config.MAX_POST_LENGTH +
          " chars long. Yours was " +
          ctx.request.body.markup.length,
      );

    const postType = ctx.vals["post-type"];
    const loaded = await db.loadTopicFor(ctx.currUser, topicId, "plain");
    ctx.assert(loaded.kind === "readable", 404);
    const { topic } = loaded;
    ctx.assertAuthorized(ctx.currUser, "CREATE_POST", topic);

    // If non-rp forum, then the post must be 'ooc' type
    if (!topic.forum.is_roleplay) {
      ctx.assert(postType === "ooc", 400);
    }

    // Render the bbcode
    const html = bbcode(ctx.vals.markup);

    const { post, mentionNotificationsCount, quoteNotificationsCount } =
      await withPgPoolTransaction(pool, async (pgClient) => {
        const post = await db
          .createPost(pgClient, {
            userId: ctx.currUser.id,
            ipAddress: ctx.request.ip,
            topicId: topic.id,
            markup: ctx.vals.markup,
            html: html,
            type: postType,
            isRoleplay: topic.forum.is_roleplay,
          })
          .then(pre.presentPost);

        // Send MENTION, QUOTE and TOPIC_SUB notifications
        const { mentionsCount, quotesCount } =
          await db.notifications.notifyNewPost(pgClient, {
            author: ctx.currUser,
            postId: post.id,
            markup: ctx.vals.markup,
          });

        return {
          post,
          mentionNotificationsCount: mentionsCount,
          quoteNotificationsCount: quotesCount,
        };
      });

    ctx.flash = {
      message: [
        "success",
        util.format(
          "Post created. Mentions sent: %s, Quotes sent: %s",
          mentionNotificationsCount,
          quoteNotificationsCount,
        ),
      ],
    };

    ctx.response.redirect(post.url + "?created=true");

    // Check if post is spam in the background
    services.antispam.process(ctx, post.markup, post.id);
  },
);

////////////////////////////////////////////////////////////

//
// Show topic edit form
// For now it's just used to edit topic title
// Ensure this comes before /topics/:slug/:xxx so that "edit" is not
// considered the second param
//
router.get("/topics/:slug/edit", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 403);
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  const loaded = await db.loadTopicFor(ctx.currUser, topicId, "full");
  ctx.assert(loaded.kind === "readable", 404);
  const { topic } = loaded;
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC", topic);

  // Get tag groups
  var tagGroups = await db.findAllTagGroups();

  // TODO: Only do on RP/IntChk topics
  const topicBans = (await db.listTopicBans(topic.id)).map(pre.presentTopicBan);

  await ctx.render("edit_topic", {
    ctx,
    topic,
    selectedTagIds: (topic.tags || []).map((tag) => tag.id),
    tagGroups,
    className: "edit-topic",
    topicBans,
  });
});

// Update topic
// Params:
// - title Required
router.put("/topics/:slug/edit", async (ctx: Context) => {
  // Authorization
  ctx.assert(ctx.currUser, 403);
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  const loaded = await db.loadTopicFor(ctx.currUser, topicId, "full");
  ctx.assert(loaded.kind === "readable", 404);
  const { topic } = loaded;
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC_TITLE", topic);

  // Parameter validation

  try {
    if (ctx.request.body.title) {
      ctx.assert(cancan.can(ctx.currUser, "UPDATE_TOPIC_TITLE", topic));
      ctx
        .validateBody("title")
        .defaultTo(topic.title)
        .isLength(
          config.MIN_TOPIC_TITLE_LENGTH,
          config.MAX_TOPIC_TITLE_LENGTH,
          "Title must be " +
            config.MIN_TOPIC_TITLE_LENGTH +
            " - " +
            config.MAX_TOPIC_TITLE_LENGTH +
            " chars long",
        );
    }

    if (ctx.request.body["join-status"]) {
      ctx.assert(cancan.can(ctx.currUser, "UPDATE_TOPIC_JOIN_STATUS", topic));
      ctx
        .validateBody("join-status")
        .defaultTo(topic.join_status)
        .isIn(["jump-in", "apply", "full"], "Invalid join-status");
    }
  } catch (ex: any) {
    if (ex instanceof bouncer.ValidationError) {
      ctx.flash = {
        message: ["danger", ex.message],
        params: ctx.request.body,
      };
      ctx.response.redirect(topic.url + "/edit");
      return;
    }
    throw ex;
  }

  // Validation succeeded, so update topic
  await db.updateTopic(topic.id, {
    title: ctx.vals.title,
    join_status: ctx.vals["join-status"],
  });

  ctx.flash = { message: ["success", "Topic updated"] };
  ctx.response.redirect(topic.url + "/edit");
});

// Always redirects to the last post of a tab
router.get("/topics/:slug/:postType/last", async (ctx: Context) => {
  const { postType } = ctx.params;
  ctx.assert(["ic", "ooc", "char"].includes(postType), 404);

  // This url should not be indexed
  ctx.set("X-Robots-Tag", "noindex");

  // Load topic
  const topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  const loaded = await db.loadTopicFor(ctx.currUser, topicId, "full");
  ctx.assert(loaded.kind === "readable", 404);
  const { topic } = loaded;

  const lastPostId = topic[`latest_${postType}_post_id`];
  ctx.assert(lastPostId, 404);

  ctx.redirect(`/posts/${lastPostId}`);
});

// Go to first unread post in a topic
router.get("/topics/:slug/:postType/first-unread", async (ctx: Context) => {
  // This page should not be indexed
  ctx.set("X-Robots-Tag", "noindex");

  // Load topic
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);

  const loaded = await db.loadTopicFor(
    ctx.currUser,
    topicId,
    ctx.currUser ? "with-subscription" : "full",
  );
  ctx.assert(loaded.kind === "readable", 404);
  const { topic } = loaded;

  // If user is not logged in, just go to first page
  if (!ctx.currUser) {
    return ctx.redirect(topic.url);
  }

  var postId = await db.findFirstUnreadPostId({
    topic_id: topic.id,
    user_id: ctx.currUser.id,
    post_type: ctx.params.postType,
  });

  if (postId) {
    ctx.redirect("/posts/" + postId);
  } else {
    ctx.redirect(topic.url + "/" + ctx.params.postType);
  }
});

//
// Canonical show topic
//
// This router is mounted before the one in server/index.ts, so this route
// shadows any GET /topics/:slug/<word> registered there. Register such a
// route above this one, in this file.
//

router.get("/topics/:slug/:postType", async (ctx: Context) => {
  ctx.assert(["ic", "ooc", "char"].includes(ctx.params.postType), 404);
  ctx
    .validateQuery("page")
    .optional()
    .tap((s) => (typeof s === "string" ? Number(s.replace(/,/g, "")) : 1));
  const topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);

  // If ?page=1 was given, then redirect without param
  // since page 1 is already the canonical destination of a topic url
  if (ctx.vals.page === 1) {
    ctx.status = 301;
    return ctx.response.redirect(ctx.request.path);
  }

  var page = Math.max(1, ctx.vals.page || 1);

  // Only incur the topic_subscriptions join if currUser exists
  const loaded = await db.loadTopicFor(
    ctx.currUser,
    topicId,
    ctx.currUser ? "with-subscription" : "full",
  );
  ctx.assert(loaded.kind === "readable", 404);
  const { topic } = loaded;

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(topic.id, topic.title);
  if (ctx.params.slug !== expectedSlug) {
    ctx.status = 301;
    ctx.response.redirect(topic.url + ctx.request.search);
    return;
  }

  // If user tried to go to ic/char tabs on a non-rp, then 404
  if (!topic.is_roleplay) {
    ctx.assert(!["ic", "char"].includes(ctx.params.postType), 404);
  }

  var totalItems = topic[ctx.params.postType + "_posts_count"];
  var totalPages = belt.calcTotalPostPages(totalItems);

  // Don't need this page when post pages are pre-calc'd in the database
  // var pager = belt.calcPager(page, config.POSTS_PER_PAGE, totalItems);

  // Redirect to the highest page if page parameter exceeded it
  if (page > totalPages) {
    var redirectUrl =
      page === 1 ? ctx.request.path : ctx.request.path + "?page=" + totalPages;
    return ctx.response.redirect(redirectUrl);
  }

  const [viewers, posts] = await Promise.all([
    db.findViewersForTopicId(topic.id),
    db.findPostsByTopicId(topicId, ctx.params.postType, page),
  ]);

  let zeroth;
  if (posts[0] && posts[0].idx === -1) {
    zeroth = pre.presentPost(posts.shift());
  }

  if (ctx.currUser) {
    posts.forEach((post) => {
      const rating = post.ratings.find(
        (x) => x.from_user_id === ctx.currUser.id,
      );
      (post as any).has_rated = rating;
    });
  }

  // Update watermark
  if (ctx.currUser && posts.length > 0) {
    await db
      .updateTopicWatermark({
        topic_id: topic.id,
        user_id: ctx.currUser.id,
        post_type: ctx.params.postType,
        post_id: belt.last(posts)!.id,
      })
      .catch((err) => console.error("error updating topic watermark", err));
  }

  // Clear sub notifications with this topic_id if they have sub_notes > 0
  if (ctx.currUser && ctx.currUser.sub_notifications_count > 0) {
    const notesDeleted = await db.deleteSubNotifications(ctx.currUser.id, [
      topic.id,
    ]);
    ctx.currUser.sub_notifications_count = Math.max(
      0,
      ctx.currUser.sub_notifications_count - notesDeleted,
    );
    ctx.currUser.notifications_count = Math.max(
      0,
      ctx.currUser.notifications_count - notesDeleted,
    );
  }

  // If we're on the last page, remove the unread button
  // Since we update the watermark in the background, the find-topic
  // query doesn't consider this page read yet
  if (page === totalPages) {
    topic["unread_" + ctx.params.postType] = false;
  }

  topic.posts = posts.map(pre.presentPost);
  var postType = ctx.params.postType;

  // update viewers in background
  db.upsertViewer(ctx, topic.forum_id, topic.id).catch(console.error);

  await ctx.render("show_topic", {
    ctx,
    topic: topic,
    postType: postType,
    title: topic.is_roleplay
      ? "[" +
        postType.toUpperCase() +
        "] " +
        topic.title +
        (page > 1 ? " (Page " + page + ")" : "")
      : topic.title,
    categories: cache3.get("categories"),
    zeroth,
    className: "show-topic",
    // Pagination
    currPage: page,
    totalPages: totalPages,
    // Viewer tracker
    viewers: viewers,
  });
});

// Legacy URL
// Redirect to the new, shorter topic URL
router.get("/topics/:topicId/posts/:postType", async (ctx: Context) => {
  var redirectUrl = "/topics/" + ctx.params.topicId + "/" + ctx.params.postType;
  ctx.status = 301;
  ctx.response.redirect(redirectUrl);
});

//
// Redirect topic to canonical url
//
// If roleplay (so guaranteed to have a OOC post OR a IC post)
//   If it has an IC post, go to IC tab
//   Else it must have an OOC post, so go to OOC tab
// Else it is a non-roleplay
//   Go to OOC tab
//
router.get("/topics/:slug", async (ctx: Context) => {
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);

  const loaded = await db.loadTopicFor(ctx.currUser, topicId, "plain");

  // If user cannot read topic and it's deleted, redirect them to
  // the forum and explain what happened
  if (loaded.kind === "hidden") {
    ctx.flash = {
      message: [
        "warning",
        `
        The topic you tried to view has been hidden. It was possibly spam.
      `,
      ],
    };
    ctx.redirect(`/forums/${loaded.forumId}`);
    return;
  }

  ctx.assert(loaded.kind === "readable", 404);
  const { topic } = loaded;

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(topic.id, topic.title);
  if (ctx.params.slug !== expectedSlug) {
    ctx.status = 301;
    ctx.response.redirect(topic.url + ctx.request.search);
    return;
  }

  // TODO: Should these be 301?
  if (topic.forum.is_roleplay) {
    if (topic.ic_posts_count > 0) {
      ctx.response.redirect(ctx.request.path + "/ic");
    } else {
      ctx.response.redirect(ctx.request.path + "/ooc");
    }
  } else {
    ctx.response.redirect(ctx.request.path + "/ooc");
  }
});

////////////////////////////////////////////////////////////

export default router;
