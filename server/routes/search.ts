"use strict";
// 3rd
import Router from "@koa/router";
import Knex from "knex";
const knex = Knex({ client: "pg" });
import createDebug from "debug";
const debug = createDebug("app:search");
// 1st
import cache3 from "../cache3";
import * as pre from "../presenters";
import { can, MOD_CATEGORY_ID, type Actor } from "../cancan";
import { fetchReadable } from "../readable";
import { searchHeadlineSql, splitSearchHeadline } from "../search_headline";
import { Context } from "koa";

////////////////////////////////////////////////////////////

const router = new Router();

////////////////////////////////////////////////////////////

// The forums the filter panel offers (client/search_filter.tsx): the public
// categories, each forum kept only when the viewer may read it, with only the
// fields the panel shows. The page prints this, so it must not carry a staff
// forum's title to a member.
function forumChoices(viewer: Actor) {
  // TODO: Stop hard-coding lexus lounge authorization
  // Ignore lexus-lounge and test categories
  return cache3
    .get("categories")
    .filter((c) => c.id !== MOD_CATEGORY_ID && c.id !== 5)
    .map((c) => ({
      id: c.id,
      title: c.title,
      forums: c.forums
        .filter((f) => can(viewer, "READ_FORUM", f))
        .map((f) => ({ id: f.id, title: f.title })),
    }));
}

////////////////////////////////////////////////////////////

// Query
// - term (optional): search phrase
// - topic_id (optional)
// - post_types (optional)
// - forum_ids (optional)
// - user_ids (optional)
// ----
// - page
//
// TODO: Remove the old CloudSearch cruft from search_results.html and anywhere
// else in the codebase.
router.get("/search", async (ctx: Context) => {
  // Must be logged in to search
  if (!ctx.currUser) {
    ctx.flash = { message: ["danger", "You must be logged in to search"] };
    ctx.redirect("/");
    return;
  }

  ctx.set("X-Robots-Tag", "noindex");

  const perPage = 50;

  const page = ctx
    .validateQuery("page")
    .defaultTo(1)
    .toInt()
    .tap((n) => Math.max(n, 0))
    .tap((n) => Math.min(n, 1000 / perPage))
    .val();

  // If no search query, then short-circuit the DB hit
  if (Object.keys(ctx.query).length === 0) {
    await ctx.render("search_results", {
      ctx,
      posts: [],
      className: "search",
      searchParams: {},
      forumChoices: forumChoices(ctx.currUser),
    });
    return;
  }

  const term = ctx.validateQuery("term").optional().toString().trim().val();

  const topicId = ctx.validateQuery("topic_id").optional().toInt().val();

  const forumIds = ctx
    .validateQuery("forum_ids")
    .optional()
    .toArray()
    .toInts()
    .val();

  const unamesToIds = cache3.get("unames->ids");

  const unames = ctx
    .validateQuery("unames")
    .optional()
    .toArray()
    .uniq()
    // Remove unames that are not in our system
    .tap((unames) => {
      return unames.filter((uname) => unamesToIds[uname.toLowerCase()]);
    })
    .val();

  const userIds =
    unames && unames.length > 0
      ? unames.map((uname) => unamesToIds[uname.toLowerCase()])
      : undefined;

  const postTypes = ctx.validateQuery("post_types").optional().toArray().val();

  // Now we build the query. fetchReadable adds the viewer's read scope to
  // this subquery, so the 1000-row cap counts only posts the viewer may read.
  // Hidden posts stay out for everyone, staff too: server/db/index.ts#nukeUser
  // hides every post a spambot wrote.

  const subquery = knex("posts")
    .select("posts.*")
    .select(knex.raw('to_json(users.*) "user"'))
    .select(knex.raw('to_json(topics.*) "topic"'))
    .select(knex.raw('to_json(forums.*) "forum"'))
    .innerJoin("users", "users.id", "posts.user_id")
    .innerJoin("topics", "topics.id", "posts.topic_id")
    .innerJoin("forums", "forums.id", "topics.forum_id")
    .where("posts.is_hidden", false)
    .whereNotNull("posts.markup")
    .limit(1000);

  if (term) {
    subquery.whereRaw(
      `to_tsvector('english', posts.markup) @@ plainto_tsquery('english', ?)`,
      [term],
    );
  } else {
    subquery.orderBy("posts.id", "desc");
  }

  // Extra filters

  if (topicId) {
    console.log({ topicId });
    subquery.where("posts.topic_id", topicId);
  }

  // If post_type (array) is given
  if (postTypes) {
    console.log({ postTypes });
    subquery.whereIn("posts.type", postTypes);
  }

  if (forumIds) {
    console.log({ forumIds });
    subquery.whereIn("topics.forum_id", forumIds);
  }

  if (userIds) {
    console.log({ userIds });
    subquery.whereIn("posts.user_id", userIds);
  }

  const posts = await fetchReadable(ctx.currUser, "READ_POST", subquery, {
    posts: "posts",
    topics: "topics",
    forums: "forums",
    // Ranks and pages the scoped subquery
    wrap: (scoped) => {
      const query = knex
        .select("x.*")
        .from(scoped.as("x"))
        .limit(perPage)
        .offset((page - 1) * perPage);

      if (term) {
        query
          .select(
            knex.raw(
              `ts_rank(to_tsvector('english', x.markup), plainto_tsquery('english', ?)) "rank"`,
              [term],
            ),
          )
          .select({ highlight: searchHeadlineSql(knex, "x.markup", term) })
          .orderBy("rank", "desc");
      } else {
        // query.orderBy('x.id', 'desc')
      }

      debug(query.toString());
      return query;
    },
  }).then((rows) =>
    rows.map((x) => {
      const post = pre.presentPost(x);
      post.highlight = splitSearchHeadline(post.highlight);
      return post;
    }),
  );

  ctx.set("X-Robots-Tag", "noindex");

  const params = {
    unames,
    term,
    topic_id: topicId,
    forum_ids: forumIds,
    post_types: postTypes,
  };

  await ctx.render("search_results", {
    ctx,
    posts,
    page,
    perPage,
    className: "search",
    searchParams: params,
    forumChoices: forumChoices(ctx.currUser),
  });
});

////////////////////////////////////////////////////////////

export default router;
