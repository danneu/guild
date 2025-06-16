// 3rd
import Router from "@koa/router";
import _ from "lodash";
// import createDebug from 'debug'
// const debug = createDebug('app:routes:subscriptions')
// 1st
import * as db from "../db";
import * as pre from "../presenters";
import * as belt from "../belt";
import { Context } from "koa";

////////////////////////////////////////////////////////////

const router = new Router();

////////////////////////////////////////////////////////////

//
// Show subscriptions (unarchived)
//
router.get("/me/subscriptions", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);
  const [topics, subNotes] = await Promise.all([
    db.subscriptions
      .findSubscribedTopicsForUserId(ctx.currUser.id, false)
      .then((xs) => xs.map(pre.presentTopic)),
    db.findNotificationsForUserId(ctx.currUser.id, "TOPIC_SUB"),
  ]);

  subNotes.forEach((note) => {
    const topic = topics.find((t) => t.id === note.topic_id);
    if (topic) {
      // will have a flag for each postType that has unread posts
      // { ooc: true, ic: true, char: true }
      topic.sub_notes = note.meta;
    }
  });

  const grouped = _.groupBy(topics, (topic) => topic.forum.is_roleplay);
  const roleplayTopics = grouped[true] || [];
  const nonroleplayTopics = grouped[false] || [];
  await ctx.render("subscriptions", {
    ctx,
    topics,
    roleplayTopics,
    nonroleplayTopics,
    isArchive: false,
    //
    title: "My Subscriptions",
  });
});

router.get("/me/subscriptions/archive", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);
  const topics = (
    await db.subscriptions.findSubscribedTopicsForUserId(ctx.currUser.id, true)
  ).map(pre.presentTopic);
  const grouped = _.groupBy(topics, (topic) => topic.forum.is_roleplay);
  const roleplayTopics = grouped[true] || [];
  const nonroleplayTopics = grouped[false] || [];
  await ctx.render("subscriptions", {
    ctx,
    topics,
    roleplayTopics,
    nonroleplayTopics,
    isArchive: true,
    //
    title: "My Archived Subscriptions",
  });
});

//
// Create subscription
//
// Body params:
// - topic-id
router.post("/me/subscriptions", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);

  // Ensure user doesn't have 200 subscriptions
  const subs = await db.subscriptions.findSubscribedTopicsForUserId(
    ctx.currUser.id,
    false,
  );
  if (subs.length >= 200) {
    ctx.body = "You cannot have more than 200 topic subscriptions";
    return;
  }

  const topicId = ctx.request.body["topic-id"];
  ctx.assert(topicId, 404);
  const topic = await db.findTopic(topicId);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, "SUBSCRIBE_TOPIC", topic);
  // TODO: flash
  await db.subscriptions.subscribeToTopic(ctx.currUser.id, topicId);
  pre.presentTopic(topic);
  if (ctx.request.body["return-to-topic"]) {
    return ctx.response.redirect(topic.url);
  }
  const redirectTo = ctx.query.redirectTo || "/me/subscriptions";
  ctx.response.redirect(redirectTo as string);
});

//
// Remove subcription
//
router.delete("/me/subscriptions/:topicSlug", async (ctx: Context) => {
  const topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  ctx.assert(ctx.currUser, 404);
  const topic = await db.findTopic(topicId);
  ctx.assertAuthorized(ctx.currUser, "UNSUBSCRIBE_TOPIC", topic);
  await db.subscriptions.unsubscribeFromTopic(ctx.currUser.id, topicId);
  // TODO: flash
  pre.presentTopic(topic);
  if (ctx.request.body["return-to-topic"]) {
    return ctx.response.redirect(topic.url);
  }
  ctx.flash = { message: ["success", "Successfully unsubscribed"] };
  const redirectTo = ctx.query.redirectTo || "/me/subscriptions";
  ctx.response.redirect(redirectTo as string);
});

////////////////////////////////////////////////////////////

//
// Mass-update subs
//
// Body:
// - ids: Array<Int>
// - action: 'unsub' | 'archive' | 'unarchive'
router.post("/me/subscriptions/mass-action", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404, "Must be logged in");

  const action = ctx
    .validateBody("action")
    .isString()
    .isIn(["unsub", "archive", "unarchive"])
    .val();

  const ids = ctx.validateBody("ids").toArray().toInts().val();

  await db.subscriptions.massUpdate(ctx.currUser.id, ids, action);

  if (action === "archive") {
    ctx.flash = {
      message: ["success", `${ids.length} subscriptions were archived`],
    };
    ctx.redirect("/me/subscriptions/archive");
  } else if (action === "unarchive") {
    ctx.flash = {
      message: ["success", `${ids.length} subscriptions were unarchived`],
    };
    ctx.redirect("/me/subscriptions");
  } else {
    ctx.flash = {
      message: ["success", `${ids.length} subscriptions were deleted`],
    };
    ctx.back("/");
  }
});

////////////////////////////////////////////////////////////

export default router;
