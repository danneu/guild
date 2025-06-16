"use strict";
import "dotenv/config";
import * as config from "./config";
import { z } from "zod";

// Node
import fs from "fs";
import Router from "@koa/router";

import Koa, { Context, Next } from "koa";
const app = new Koa();
if (config.NODE_ENV === "production") {
  app.proxy = true;
}

import convert from "koa-convert";
import koaBetterStatic from "koa-better-static";
import koaLogger from "koa-logger";
import { koaBody } from "koa-body";

// Routes
import legacyRouter from "./legacy_router.js";
import indexRoutes from "./routes/index.js";
import usersRoutes from "./routes/users.js";
import convosRoutes from "./routes/convos.js";
import imagesRoutes from "./routes/images.js";
import diceRoutes from "./routes/dice.js";
import statusesRoutes from "./routes/statuses.js";
import chatRoutes from "./routes/chat.js";
import subscriptionsRoutes from "./routes/subscriptions.js";
import friendshipsRoutes from "./routes/friendships.js";
import tagsRoutes from "./routes/tags.js";
import discordRoutes from "./routes/discord.js";
import searchRoutes from "./routes/search.js";
import topicsRoutes from "./routes/topics.js";
import adminRoutes from "./routes/admin.js";
import verifyEmailRoutes from "./routes/verify-email.js";
import guildbot from "./guildbot.js";

// static assets

app.use(
  convert(
    koaBetterStatic("public", {
      maxage: 1000 * 60 * 60 * 24 * 365,
      gzip: false,
    }),
  ),
);

app.use(
  convert(
    koaBetterStatic("dist", {
      maxage: 1000 * 60 * 60 * 24 * 365,
      gzip: false,
    }),
  ),
);

import koaConditionalGet from "koa-conditional-get";
import koaEtag from "koa-etag";
app.use(koaConditionalGet()); // Works with koa-etag
app.use(koaEtag());

// heroku already has access logger
if (config.NODE_ENV !== "production") {
  app.use(koaLogger());
}

app.use(
  koaBody({
    multipart: true,
    // Max payload size allowed in request form body
    // Defaults to '56kb'
    // CloudFlare limits to 100mb max
    formLimit: "25mb",
  }),
);

import nunjucksRender from "koa-nunjucks-render";

// Node
import util from "util";
// 3rd party
import _ from "lodash";
import createDebug from "debug";
const debug = createDebug("app:index");
import assert from "assert";
import promiseMap from "promise.map";
// 1st party
import * as db from "./db";
import * as pre from "./presenters";
import * as middleware from "./middleware";
import * as cancan from "./cancan";
import * as emailer from "./emailer";
import * as belt from "./belt";
import bbcode from "./bbcode";
import bouncer from "koa-bouncer";
import "./validation"; // Load after koa-bouncer
import services from "./services";
import cache3 from "./cache3";
import makeAgo from "./ago";
import protectCsrf from "./middleware/protect-csrf";
import { pool } from "./db/util";

app.use(middleware.methodOverride());

app.use(
  protectCsrf([
    "roleplayerguild.com",
    "localhost",
    "rpguild.fly.dev",
    "rpguild-staging.fly.dev",
  ]),
);

// Catch and log all errors that bubble up to koa
// app.on('error', function(err) {
//   log.error(err, 'Error');
//   console.error('Error:', err, err.stack);
// });

// app.use(function*(next) {
//   var start = Date.now();
//   ctx.log = log.child({ req_id: uuid.v1() });  // time-based uuid
//   ctx.log.info({ req: ctx.request }, '--> %s %s', ctx.method, ctx.path);
//   await next;
//   var diff = Date.now() - start;
//   ctx.log.info({ ms: diff, res: ctx.response },
//                 '<-- %s %s %s %s',
//                 ctx.method, ctx.path, ctx.status, diff + 'ms');
// });

// Upon app boot, check for compiled assets
// in the `dist` folder. If found, attach their
// paths to the context so the view layer can render
// them.
//
// Example value of `dist`:
// { css: 'all-ab42cf1.css', js: 'all-d181a21.js' }'
const dist = (() => {
  const manifestPath = "./dist/rev-manifest.json";
  let body;
  try {
    body = fs.readFileSync(manifestPath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log("assets not compiled (dist/rev-manifest.json not found)");
      return;
    } else {
      throw err;
    }
  }
  const manifest = JSON.parse(body);
  const dist = {
    css: manifest["all.css"],
    js: manifest["all.js"],
  };
  console.log("dist set", dist);
  return dist;
})();

// Only allow guild to be iframed from same domain
app.use(async (ctx: Context, next: Next) => {
  ctx.set("X-Frame-Options", "SAMEORIGIN");
  return next();
});

app.use(async (ctx: Context, next: Next) => {
  ctx.dist = dist;
  return next();
});

// Expose config to view layer
// TODO: use nunjucks instead of MW
app.use(async (ctx: Context, next: Next) => {
  ctx.config = config;
  ctx.cache = cache3;
  return next();
});

// Remove trailing slashes from url path
app.use(async (ctx: Context, next: Next) => {
  // If path has more than one character and ends in a slash, then redirect to
  // the same path without that slash. Note: homepage is "/" which is why
  // we check for more than 1 char.
  if (/.+\/$/.test(ctx.request.path)) {
    const newPath = ctx.request.path.slice(0, ctx.request.path.length - 1);
    ctx.status = 301;
    ctx.response.redirect(newPath + ctx.request.search);
  }

  return next();
});

// TODO: Since app.proxy === true (we trust X-Proxy-* headers), we want to
// reject all requests that hit origin. app.proxy should only be turned on
// when app is behind trusted proxy like Cloudflare.

/// /////////////////////////////////////////////////////////

app.use(middleware.currUser());
app.use(middleware.flash());

app.use(async (ctx: Context, next: Next) => {
  // Must become before koa-router
  ctx.can = cancan.can;
  ctx.assertAuthorized = (user, action, target) => {
    const canResult = cancan.can(user, action, target);
    // ctx.log.info('[assertAuthorized] Can %s %s: %s',
    //              (user && user.uname) || '<Guest>', action, canResult);
    debug(
      "[assertAuthorized] Can %j %j: %j",
      (user && user.uname) || "<Guest>",
      action,
      canResult,
    );
    ctx.assert(canResult, 404);
  };
  return next();
});

// Configure Nunjucks
/// /////////////////////////////////////////////////////////

const nunjucksOptions = {
  // `await ctx.render('show_user')` will assume that a show_user.html exists
  ext: ".html",
  noCache: config.NODE_ENV === "development",
  // if true, throw an error if we try to {{ x }} where x is null or undefined in
  // templates. helps catch bugs and forces us to explicitly {{ x or '' }}
  throwOnUndefined: false,
  // globals are bindings we want to expose to all templates
  globals: {
    _: _,
    belt,
    cancan,
    // let us use `can(USER, ACTION, TARGET)` authorization-checks in templates
    can: cancan.can,
    cannot: cancan.cannot,
    config,
    Math,
    Date,
    Object,
    cache3,
    ago: makeAgo(),
    currYear: () => new Date().getFullYear(),
  },
  // filters are functions that we can pipe values to from nunjucks templates.
  // e.g. {{ user.uname | md5 | toAvatarUrl }}
  filters: {
    json: (s) => JSON.stringify(s, null, "  "),
    ordinalize: belt.ordinalize,
    getOrdinalSuffix: belt.getOrdinalSuffix,
    isNewerThan: belt.isNewerThan,
    isOlderThan: belt.isOlderThan,
    expandJoinStatus: belt.expandJoinStatus,
    // {% if user.id|isIn([1, 2, 3]) %}
    isIn: (v, coll) => (coll || []).includes(v),
    // {% if things|isEmpty %}
    isEmpty: (coll) => _.isEmpty(coll),
    // Specifically replaces \n with <br> in user.custom_title
    replaceTitleNewlines: (str) => {
      if (!str) return "";
      return _.escape(str)
        .replace(/\\n/, "<br>")
        .replace(/^<br>|<br>$/g, "");
    },
    replaceTitleNewlinesMobile: (str) => {
      if (!str) return "";
      return _.escape(str)
        .replace(/(?:\\n){2,}/, "\n")
        .replace(/^\\n|\\n$/g, "")
        .replace(/\\n/, " / ");
    },
    // Sums `nums`, an array of numbers. Returns zero if `nums` is falsey.
    sum: (nums) => {
      return (nums || []).reduce((memo, n) => memo + n, 0);
    },
    parseIntOr: (str, defaultTo = 0) => {
      const n = Number.parseInt(str, 10);
      return Number.isNaN(n) ? defaultTo : n;
    },
    // Sums the values of an object
    sumValues: (obj) => {
      return _.values(obj).reduce((memo, n) => memo + n, 0);
    },
    ratingTypeToImageSrc: (type) => {
      switch (type) {
        case "like":
          return "/ratings/like.png";
        case "laugh":
          return "/ratings/laugh-static.png";
        case "thank":
          return "/ratings/thank.png";
        default:
          throw new Error("Unsupported rating type: " + type);
      }
    },
    isString: (x) => typeof x === "string",
    // {{ 'firetruck'|truncate(5) }}  -> 'firet...'
    // {{ 'firetruck'|truncate(6) }}  -> 'firetruck'
    truncate: belt.makeTruncate("…"),
    // Returns distance from now to date in days. 0 or more.
    daysAgo: belt.daysAgo,
    // FIXME: Can't render bbcode on the fly until I speed up
    // slow bbcode like tabs
    bbcode,
    // commafy(10) -> 10
    // commafy(1000000) -> 1,000,000
    commafy: (n) => (n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","),
    formatDate: pre.formatDate,
    slugifyUname: belt.slugifyUname,
    presentUserRole: belt.presentUserRole,
    encodeURIComponent: (s) => encodeURIComponent(s),
    // String -> String
    outcomeToElement: (outcome: string) => {
      switch (outcome) {
        case "WIN":
          return '<span class="green-glow">Win</span>';
        case "LOSS":
          return '<span class="red-glow">Loss</span>';
        case "DRAW":
          return '<span style="color: #999">Draw</span>';
        // TODO: Had to add this for type warning. need to see what i had expected
        // this behavior to be.
        default:
          return;
      }
    },
    formatChatDate: belt.formatChatDate,
    bitAnd: (input, mask) => input & mask,
    bitOr: (input, mask) => input | mask,
  },
};

app.use(nunjucksRender("views", nunjucksOptions));

/// /////////////////////////////////////////////////////////
// Routes //////////////////////////////////////////////////
/// /////////////////////////////////////////////////////////

app.use(bouncer.middleware());

app.use(async (ctx: Context, next: Next) => {
  try {
    await next();
  } catch (ex: any) {
    // Catch any ZodErrors that bubble up and return a flash message
    if (ex instanceof z.ZodError) {
      // Adding the path is nice if I forget to set a message: `Required (username)`
      // FIXME: But if I do add a custom message, then it's weird: `You must set a tag (tag)`
      const message = ex.issues[0]
        ? `${ex.issues[0].message} (${ex.issues[0].path.join(".")})`
        : ex.message;
      ctx.flash = {
        message: ["danger", message],
        // FIXME: This breaks if body is bigger than ~4kb cookie size limit
        // i.e. large posts, large bodies of text
        params: ctx.request.body,
      };
      ctx.response.redirect("back");
      return;
    }
    if (ex instanceof bouncer.ValidationError) {
      ctx.flash = {
        message: ["danger", ex.message || "Validation error"],
        // FIXME: This breaks if body is bigger than ~4kb cookie size limit
        // i.e. large posts, large bodies of text
        params: ctx.request.body,
      };
      ctx.response.redirect("back");
      return;
    }
    throw ex;
  }
});

//app.use(require('./middleware/track')())

// - Create middleware before this
// app.use(require('@koa/router')(app))
const router = new Router();

// For fly.io health check
router.get("/health", (ctx: Context) => {
  ctx.status = 200;
});

router.post("/test", async (ctx: Context) => {
  ctx.body = JSON.stringify(ctx.request.body, null, "  ");
});

app.use(legacyRouter.routes());

/// /////////////////////////////////////////////////////////

router.get("/rules", async (ctx: Context) => {
  ctx.assert(config.RULES_POST_ID, 404);
  ctx.redirect(`/posts/${config.RULES_POST_ID}`);
});

app.use(indexRoutes.routes());
app.use(usersRoutes.routes());
app.use(convosRoutes.routes());
app.use(imagesRoutes.routes());
app.use(diceRoutes.routes());
app.use(statusesRoutes.routes());
app.use(chatRoutes.routes());
app.use(subscriptionsRoutes.routes());
app.use(friendshipsRoutes.routes());
app.use(tagsRoutes.routes());
app.use(discordRoutes.routes());
app.use(searchRoutes.routes());
app.use(topicsRoutes.routes());
app.use(adminRoutes.routes());
app.use(verifyEmailRoutes.routes());

// Useful to redirect users to their own profiles since canonical edit-user
// url is /users/:slug/edit

// Ex: /me/edit#grayscale-avatars to show users how to toggle that feature
router.get("/me/edit", async (ctx: Context) => {
  // Ensure current user can edit themself
  ctx.assertAuthorized(ctx.currUser, "UPDATE_USER", ctx.currUser);

  // Note: Redirects fragment params
  ctx.response.redirect("/users/" + ctx.currUser.slug + "/edit");
});

/// /////////////////////////////////////////////////////////

router.post("/topics/:topicSlug/co-gms", async (ctx: Context) => {
  var topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC_CO_GMS", topic);

  ctx.validateBody("uname").isString("Username required");
  var user = await db.findUserByUname(ctx.vals.uname);
  // Ensure user exists
  ctx.check(user, "User does not exist");
  // Ensure user is not already a co-GM
  ctx.check(!topic.co_gm_ids.includes(user.id), "User is already a co-GM");
  // Ensure user is not the GM
  ctx.check(user.id !== topic.user.id, "User is already the GM");
  // Ensure topic has room for another co-GM
  ctx.check(
    topic.co_gm_ids.length < config.MAX_CO_GM_COUNT,
    "Cannot have more than " + config.MAX_CO_GM_COUNT + " co-GMs",
  );

  await db.updateTopicCoGms(topic.id, [...topic.co_gm_ids, user.id]);

  // If user is topic-banned, delete the ban
  if ((topic.banned_ids || []).includes(user.id)) {
    await db.deleteUserTopicBan(topic.id, user.id);
  }

  ctx.flash = {
    message: ["success", util.format("Co-GM added: %s", ctx.vals.uname)],
  };
  ctx.response.redirect(topic.url + "/edit#co-gms");
});

/// /////////////////////////////////////////////////////////

router.delete("/topics/:topicSlug/co-gms/:userSlug", async (ctx: Context) => {
  var topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC_CO_GMS", topic);

  var user = await db.findUserBySlug(ctx.params.userSlug);
  ctx.check(user, "User does not exist");
  ctx.check(topic.co_gm_ids.includes(user.id), "User is not a co-GM");

  await db.updateTopicCoGms(
    topic.id,
    topic.co_gm_ids.filter((co_gm_id) => {
      return co_gm_id !== user.id;
    }),
  );

  ctx.flash = {
    message: ["success", util.format("Co-GM removed: %s", user.uname)],
  };
  ctx.response.redirect(topic.url + "/edit#co-gms");
});

router.get("/unames.json", async (ctx: Context) => {
  ctx.type = "application/json";
  ctx.body = JSON.stringify(Array.from(cache3.get("uname-set")));
});

// Required body params:
// - type: like | laugh | thank
// - post_id: Int
router.post("/posts/:postId/rate", async (ctx: Context) => {
  try {
    ctx
      .validateBody("type")
      .isString("type is required")
      .trim()
      .isIn(["like", "laugh", "thank"], "Invalid type");
    ctx.validateBody("post_id").toInt("Invalid post_id");
  } catch (ex: any) {
    if (ex instanceof bouncer.ValidationError) {
      ctx.throw(ex.message, 400);
    }
    throw ex;
  }

  var post = await db.findPostById(ctx.vals.post_id).then(pre.presentPost);

  // Ensure post exists (404)
  ctx.assert(post, 404);

  // Ensure currUser is authorized to rep (403)
  ctx.assert(cancan.can(ctx.currUser, "RATE_POST", post), 403);

  // Ensure user has waited a certain duration since giving latest rating.
  // (To prevent rating spamming)
  var prevRating = await db.findLatestRatingForUserId(ctx.currUser.id);
  if (prevRating) {
    var threeSecondsAgo = new Date(Date.now() - 3000);
    // If this user's previous rating is newer than 3 seconds ago, fail.
    if (prevRating.created_at > threeSecondsAgo) {
      ctx.body = JSON.stringify({ error: "TOO_SOON" });
      ctx.status = 400;
      return;
    }
  }

  // Create rep
  const rating = await db.ratePost({
    post_id: post.id,
    from_user_id: ctx.currUser.id,
    from_user_uname: ctx.currUser.uname,
    to_user_id: post.user_id,
    type: ctx.vals.type,
  });

  // If rating is falsey, rating is a dupe (user probably dbl-clicked)
  // so do not create notification
  if (rating) {
    // Send receiver a RATING notification in the background
    db.createRatingNotification({
      from_user_id: ctx.currUser.id,
      to_user_id: post.user_id,
      post_id: post.id,
      topic_id: post.topic_id,
      rating_type: rating.type,
    }).catch((err) => console.error(err, err.stack));
  }

  ctx.type = "json";
  ctx.body = rating;
});

//
// Logout
//
router.post("/me/logout", async (ctx: Context) => {
  if (ctx.currUser) {
    await db.logoutSession(ctx.currUser.id, ctx.cookies.get("sessionId"));
  }
  ctx.flash = { message: ["success", "Session terminated"] };
  ctx.redirect("/");
});

//
// Login form
//
router.get("/login", async (ctx: Context) => {
  await ctx.render("login", {
    ctx,
    title: "Login",
  });
});

//
// Create session
//
router.post("/sessions", async (ctx: Context) => {
  ctx.validateBody("uname-or-email").required("Invalid creds (1)");
  ctx.validateBody("password").required("Invalid creds (2)");
  ctx.validateBody("remember-me").toBoolean();
  var user = await db.findUserByUnameOrEmail(ctx.vals["uname-or-email"]);
  ctx.check(user, "Invalid creds (3)");
  ctx.check(
    await belt.checkPassword(ctx.vals.password, user.digest),
    "Invalid creds (4)",
  );

  // User authenticated
  var session = await db.createSession(pool, {
    userId: user.id,
    ipAddress: ctx.request.ip,
    interval: ctx.vals["remember-me"] ? "1 year" : "2 weeks",
  });

  ctx.cookies.set("sessionId", session.id, {
    expires: ctx.vals["remember-me"]
      ? belt.futureDate({ years: 1 })
      : undefined,
  });
  ctx.flash = { message: ["success", "Logged in successfully"] };
  ctx.response.redirect("/");
});

//
// BBCode Cheatsheet
//
router.get("/bbcode", async (ctx: Context) => {
  await ctx.render("bbcode_cheatsheet", {
    ctx,
    title: "BBCode Cheatsheet",
  });
});

//
// Registration form
//
router.get("/register", async (ctx: Context) => {
  assert(config.RECAPTCHA_SITEKEY);
  assert(config.RECAPTCHA_SITESECRET);
  const registration = await db.keyvals.getRowByKey("REGISTRATION_ENABLED");
  await ctx.render("register", {
    ctx,
    registration,
    title: "Register",
  });
});

//
// Homepage
//
router.get("/", async (ctx: Context) => {
  const categories = cache3.get("categories");
  // We don't show the mod forum on the homepage.
  // Nasty, but just delete it for now
  // TODO: Abstract
  _.remove(categories, { id: 4 });

  const allForums = _.flatten(categories.map((c) => c.forums));

  // Assoc forum viewCount from cache
  var viewerCounts = cache3.get("forum-viewer-counts");
  allForums.forEach((forum) => {
    forum.viewerCount = viewerCounts[forum.id];
  });

  var topLevelForums = _.reject(allForums, "parent_forum_id");
  var childForums = _.filter(allForums, "parent_forum_id");

  // Map of {CategoryId: [Forums...]}
  childForums.forEach((childForum) => {
    var parentIdx = _.findIndex(topLevelForums, {
      id: childForum.parent_forum_id,
    });
    if (_.isArray(topLevelForums[parentIdx].forums)) {
      topLevelForums[parentIdx].forums.push(childForum);
    } else {
      topLevelForums[parentIdx].forums = [childForum];
    }
  });
  var groupedTopLevelForums = _.groupBy(topLevelForums, "category_id");
  categories.forEach((category) => {
    category.forums = (groupedTopLevelForums[category.id] || []).map(
      pre.presentForum,
    );
  });

  // Get stats
  var stats = cache3.get("stats");
  stats.onlineUsers.forEach(pre.presentUser);
  pre.presentUser(stats.latestUser);

  var latest_rpgn_topic = pre.presentTopic(cache3.get("latest-rpgn-topic"));

  // The unacknowledged feedback_topic for the current user
  // Will be undefined if we have nothing to show the user.
  let ftopic;
  if (config.CURRENT_FEEDBACK_TOPIC_ID && ctx.currUser) {
    ftopic = await db
      .findUnackedFeedbackTopic(
        config.CURRENT_FEEDBACK_TOPIC_ID,
        ctx.currUser.id,
      )
      .then((ftopic) => {
        // Discard ftopic if currUser has registered after it.
        if (ftopic && ctx.currUser.created_at > ftopic.created_at) {
          return ftopic;
        }
      });
  }

  // Get users friends for the sidebar
  const friendships = { count: 0, ghosts: [] as any[], nonghosts: [] as any[] };
  if (ctx.currUser) {
    const rows = (await db.findFriendshipsForUserId(ctx.currUser.id, 10)).map(
      pre.presentFriendship,
    );

    rows.forEach((row: any) => {
      friendships.count += 1;
      if (
        row.to_user.is_ghost &&
        !row.is_mutual &&
        belt.withinGhostRange(row.to_user.last_online_at)
      ) {
        friendships.ghosts.push(row);
      } else {
        friendships.nonghosts.push(row);
      }
    });
  }

  await ctx.render("homepage", {
    ctx,
    categories,
    stats,
    latest_rpgn_topic,
    ftopic,
    friendships,
    // For sidebar
    latestChecks: cache3.get("latest-checks").map(pre.presentTopic),
    latestRoleplays: cache3.get("latest-roleplays").map(pre.presentTopic),
    latestStatuses: cache3.get("latest-statuses").map(pre.presentStatus),
    currentContest: cache3.get("current-sidebar-contest"),
  });
});

//
// Forgot password page
//
router.get("/forgot", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }
  await ctx.render("forgot", {
    ctx,
    title: "Forgot Password",
  });
});

//
//
// - Required param: email
router.post("/forgot", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }

  var email = ctx.request.body.email;
  if (!email) {
    ctx.flash = { message: ["danger", "You must provide an email"] };
    ctx.response.redirect("/forgot");
    return;
  }
  // Check if it belongs to a user
  var user = await db.findUserByEmail(email);

  // Always send the same message on success and failure.
  var successMessage = "Check your email";

  // Don't let the user know if the email belongs to anyone.
  // Always look like a success
  if (!user) {
    // ctx.log.info('User not found with email: %s', email);
    ctx.flash = { message: ["success", successMessage] };
    ctx.response.redirect("/");
    return;
  }

  // Don't send another email until previous reset token has expired
  if (await db.findLatestActiveResetToken(user.id)) {
    // ctx.log.info('User already has an active reset token');
    ctx.flash = { message: ["success", successMessage] };
    ctx.response.redirect("/");
    return;
  }

  var resetToken = await db.createResetToken(user.id);
  // ctx.log.info({ resetToken: resetToken }, 'Created reset token');
  // Send email in background
  // ctx.log.info('Sending email to %s', user.email);
  try {
    await emailer.sendResetTokenEmail(user.uname, user.email, resetToken.token);
  } catch (err) {
    ctx.flash = {
      message: [
        "danger",
        "For some reason, the email failed to be sent. Email me at <mahz@roleplayerguild.com> to let me know.",
      ],
    };
    ctx.redirect("back");
    return;
  }

  ctx.flash = { message: ["success", successMessage] };
  ctx.response.redirect("/");
});

// Password reset form
// - This form allows a user to enter a reset token and new password
// - The email from /forgot will link the user here
router.get("/reset-password", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }
  var resetToken = ctx.request.query.token;
  await ctx.render("reset_password", {
    ctx,
    resetToken: resetToken,
    title: "Reset Password with Token",
  });
});

// Params
// - token
// - password1
// - password2
router.post("/reset-password", async (ctx: Context) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = "This feature is currently disabled";
    return;
  }
  var token = ctx.request.body.token;
  var password1 = ctx.request.body.password1;
  var password2 = ctx.request.body.password2;
  ctx.validateBody("remember-me").toBoolean();
  var rememberMe = ctx.vals["remember-me"];

  // Check passwords
  if (password1 !== password2) {
    ctx.flash = {
      message: [
        "danger",
        "Your new password and the new password confirmation must match",
      ],
      params: { token: token },
    };
    return ctx.response.redirect("/reset-password?token=" + token);
  }

  // Check reset token
  var user = await db.findUserByResetToken(token);

  if (!user) {
    ctx.flash = {
      message: [
        "danger",
        "Invalid reset token. Either you typed the token in wrong or the token expired.",
      ],
    };
    return ctx.response.redirect("/reset-password?token=" + token);
  }

  // Reset token and passwords were valid, so update user password
  await db.updateUserPassword(user.id, password1);

  // Delete user's reset tokens - They're for one-time use
  await db.deleteResetTokens(user.id);

  // Log the user in
  var interval = rememberMe ? "1 year" : "1 day";
  var session = await db.createSession(pool, {
    userId: user.id,
    ipAddress: ctx.request.ip,
    interval: interval,
  });
  ctx.cookies.set("sessionId", session.id, {
    expires: belt.futureDate(
      new Date(),
      rememberMe ? { years: 1 } : { days: 1 },
    ),
  });

  ctx.flash = { message: ["success", "Your password was updated"] };
  return ctx.response.redirect("/");
});

//
// Lexus lounge (Mod forum)
//
// The user that STAFF_REPRESENTATIVE_ID points to.
// Loaded once upon boot since env vars require reboot to update.
var staffRep;
router.get("/lexus-lounge", async (ctx: Context) => {
  ctx.assertAuthorized(ctx.currUser, "LEXUS_LOUNGE");

  if (!staffRep && config.STAFF_REPRESENTATIVE_ID) {
    staffRep = await db
      .findUser(config.STAFF_REPRESENTATIVE_ID)
      .then(pre.presentUser);
  }

  const latestUserLimit = 50;

  const [latestUsers, registration, category, unameChanges] = await Promise.all(
    [
      db.findLatestUsers(latestUserLimit).then((xs) => xs.map(pre.presentUser)),
      db.keyvals.getRowByKey("REGISTRATION_ENABLED"),
      db.findModCategory(),
      db.unames
        .latestUnameChanges()
        .then((xs) => xs.map(pre.presentUnameChange)),
    ],
  );

  const forums = await db.findForums([category.id]);

  category.forums = forums;
  pre.presentCategory(category); // must come after .forums assignment

  await ctx.render("lexus_lounge", {
    ctx,
    category,
    latestUsers,
    latestUserLimit,
    staffRep,
    registration,
    unameChanges,
    title: "Lexus Lounge — Mod Forum",
  });
});

router.get("/lexus-lounge/images", async (ctx: Context) => {
  ctx.assertAuthorized(ctx.currUser, "LEXUS_LOUNGE");
  const images = await db.images
    .getLatestImages(25)
    .then((xs) => xs.map(pre.presentImage));
  await ctx.render("lexus_lounge_images", {
    ctx,
    images,
    title: "Latest Images - Lexus Lounge",
  });
});

// toggle user registration on/off
router.post("/lexus-lounge/registration", async (ctx: Context) => {
  ctx.assertAuthorized(ctx.currUser, "LEXUS_LOUNGE");
  const enable = ctx.request.body.enable === "true";
  await db.keyvals.setKey("REGISTRATION_ENABLED", enable, ctx.currUser.id);
  ctx.flash = {
    message: ["success", `Registrations ${enable ? "enabled" : "disabled"}`],
  };
  ctx.redirect("/lexus-lounge");
});

//
// New topic form
//
router.get("/forums/:forumSlug/topics/new", async (ctx: Context) => {
  // Load forum
  var forumId = belt.extractId(ctx.params.forumSlug);
  ctx.assert(forumId, 404);
  var forum = await db.findForum(forumId).then(pre.presentForum);
  ctx.assert(forum, 404);

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
// @koa2
router.get("/forums/:forumSlug", async (ctx: Context) => {
  var forumId = belt.extractId(ctx.params.forumSlug);
  ctx.assert(forumId, 404);

  ctx.validateQuery("page").optional().toInt();

  var forum = await db.findForum2(forumId).then(pre.presentForum);
  ctx.assert(forum, 404);

  forum.mods = cache3.get("forum-mods")[forum.id] || [];
  pre.presentForum(forum);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(forum.id, forum.title);
  if (ctx.params.forumSlug !== expectedSlug) {
    ctx.status = 301;
    ctx.response.redirect(forum.url + ctx.request.search);
    return;
  }

  ctx.assertAuthorized(ctx.currUser, "READ_FORUM", forum);

  var pager = belt.calcPager(ctx.vals.page, 25, forum.topics_count);

  const [viewers, topics] = await Promise.all([
    db.findViewersForForumId(forum.id),
    // Avoids the has_posted subquery if guest
    ctx.currUser
      ? db.findTopicsWithHasPostedByForumId(
          forumId,
          pager.limit,
          pager.offset,
          ctx.currUser.id,
          cancan.isStaffRole(ctx.currUser.role),
        )
      : db.findTopicsByForumId(forumId, pager.limit, pager.offset, false),
  ]);

  forum.topics = topics;
  pre.presentForum(forum);

  const tabbedForums = [
    forum.parent_forum,
    ...forum.sibling_forums,
    ...forum.child_forums,
  ].filter(Boolean);

  // update viewers in background
  db.upsertViewer(ctx, forum.id).catch((err) => console.error(err, err.stack));

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

//
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

    var postType = ctx.vals["post-type"];
    var topic = await db.findTopic(topicId);
    ctx.assert(topic, 404);
    topic.mods = cache3.get("forum-mods")[topic.forum_id] || [];
    ctx.assertAuthorized(ctx.currUser, "CREATE_POST", topic);

    // If non-rp forum, then the post must be 'ooc' type
    if (!topic.forum.is_roleplay) {
      ctx.assert(postType === "ooc", 400);
    }

    // Render the bbcode
    var html = bbcode(ctx.vals.markup);

    var post = await db
      .createPost({
        userId: ctx.currUser.id,
        ipAddress: ctx.request.ip,
        topicId: topic.id,
        markup: ctx.vals.markup,
        html: html,
        type: postType,
        isRoleplay: topic.forum.is_roleplay,
      })
      .then(pre.presentPost);

    // Send MENTION and QUOTE notifications
    var results = await Promise.all([
      db.parseAndCreateMentionNotifications({
        fromUser: ctx.currUser,
        markup: ctx.vals.markup,
        post_id: post.id,
        topic_id: post.topic_id,
      }),
      db.parseAndCreateQuoteNotifications({
        fromUser: ctx.currUser,
        markup: ctx.vals.markup,
        post_id: post.id,
        topic_id: post.topic_id,
      }),
    ]);

    var mentionNotificationsCount = results[0].length;
    var quoteNotificationsCount = results[1].length;
    {
      // Send subscription notifications

      // Get all people who do not have this sub archived
      const subscribers = (
        await db.subscriptions.listActiveSubscribersForTopic(post.topic_id)
      )
        // Ignore self
        .filter((u) => u.id !== ctx.currUser.id);

      // Create notifications in the background
      promiseMap(
        subscribers,
        ({ id }) => {
          return db.createSubNotification(
            ctx.currUser.id,
            id,
            post.topic_id,
            postType,
          );
        },
        2,
      ).catch((err) =>
        console.error("error creating sub notes on new post:", err),
      );
    }

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

// (AJAX)
// Delete specific notification
router.del("/api/me/notifications/:id", async (ctx: Context) => {
  ctx.validateParam("id");
  var n = await db.findNotificationById(ctx.vals.id);
  // Ensure exists
  ctx.assert(n, 404);
  // Ensure user authorized;
  ctx.assert(cancan.can(ctx.currUser, "DELETE_NOTIFICATION", n), 403);
  // Delete it
  await db.deleteNotificationForUserIdAndId(ctx.currUser.id, n.id);
  // Return success
  ctx.status = 200;
});

// Delete many notifications
//
// Required body params:
// ids: [Integer] - The notification ids to delete
//   - May contain `-1` to force the array from the form
//     Anything non-positive will simply be filtered out first
//   - The purpose of passing in notifications ids instead of just
//     clearing all of a user's notifications is so that clicking the
//     "clear notifications" button only deletes the notifications the
//     user has on screen and not any notifications they may've received
//     in the meantime.
router.del("/me/notifications", async (ctx: Context) => {
  ctx
    .validateBody("ids")
    .toInts()
    .tap(function (ids) {
      debug(ids);
      return ids.filter(function (n) {
        return n > 0;
      });
    });

  // Ensure a user is logged in
  ctx.assert(ctx.currUser, 404);

  await db.clearNotifications(ctx.currUser.id, ctx.vals.ids);

  ctx.flash = { message: ["success", "Notifications cleared"] };
  var redirectTo = ctx.request.body["redirect-to"] || "/me/notifications";
  ctx.response.redirect(redirectTo);
});

// Delete only convo notifications
router.delete("/me/notifications/convos", async (ctx: Context) => {
  // Ensure a user is logged in
  ctx.assert(ctx.currUser, 404);
  await db.clearConvoNotifications(ctx.currUser.id);
  ctx.flash = {
    message: ["success", "PM notifications cleared"],
  };
  ctx.response.redirect("/me/convos");
});

//
// Update topic tags
// - tag-ids: Required [StringIds]
//
router.put("/topics/:topicSlug/tags", async (ctx: Context) => {
  // Load topic
  var topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);

  // Authorize user
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC_TAGS", topic);

  // Validate body params
  ctx
    .validateBody("tag-ids")
    .toInts()
    .uniq()
    .tap(function (ids) {
      return ids.filter(function (n) {
        return n > 0;
      });
    })
    .isLength(1, 7, "Must select 1-7 tags");

  // Add this forum's tag_id if it has one
  var tagIds = _.chain(ctx.vals["tag-ids"])
    .concat(topic.forum.tag_id ? [topic.forum.tag_id] : [])
    .uniq()
    .value();

  // Update topic
  await db.updateTopicTags(topic.id, tagIds);

  ctx.flash = { message: ["success", "Tags updated"] };
  ctx.response.redirect(topic.url + "/edit");
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
router.post(
  "/forums/:slug/topics",
  middleware.ratelimit(),
  async (ctx: Context) => {
    var forumId = belt.extractId(ctx.params.slug);
    ctx.assert(forumId, 404);

    // Ensure user is logged in
    ctx.assert(ctx.currUser, 403);

    // Load forum
    var forum = await db.findForumById(forumId).then(pre.presentForum);

    // Ensure forum exists
    ctx.assert(forum, 404);

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

    // Render BBCode to html
    var html = bbcode(ctx.vals.markup);

    // post-type is always ooc for non-RPs
    var postType = forum.is_roleplay ? ctx.vals["post-type"] : "ooc";

    var tagIds = _.chain(ctx.vals["tag-ids"])
      .concat(forum.tag_id ? [forum.tag_id] : [])
      .uniq()
      .value();

    // Create topic
    var topic = await db
      .createTopic({
        userId: ctx.currUser.id,
        forumId: forumId,
        ipAddress: ctx.request.ip,
        title: ctx.vals.title,
        markup: ctx.vals.markup,
        html: html,
        postType: postType,
        isRoleplay: forum.is_roleplay,
        tagIds: tagIds,
        joinStatus: ctx.vals["join-status"],
      })
      .then(pre.presentTopic);

    ctx.response.redirect(topic.url);

    // Check if post is spam after response is sent
    const result = await services.antispam.process(
      ctx,
      ctx.vals.markup,
      topic.post.id,
    );

    // Don't broadcast to discord if they tripped the spam detector
    if (!result && topic.forum_id === 2) {
      services.discord
        .broadcastIntroTopic(ctx.currUser, topic)
        .catch((err) => console.error("broadcastIntroTopic failed", err));
    }
  },
);

// Edit post form
// - The "Edit" button on posts links here so that people without
// javascript or poor support for javascript will land on a basic edit-post
// form that does not depend on javascript.
router.get("/posts/:id/edit", async (ctx: Context) => {
  // Short-circuit if user isn't logged in
  ctx.assert(ctx.currUser, 403);

  // Load the post
  var post = await db.findPostById(ctx.params.id).then(pre.presentPost);

  // 404 if it doesn't exist
  ctx.assert(post, 404);

  // Ensure current user is authorized to edit the post
  ctx.assertAuthorized(ctx.currUser, "UPDATE_POST", post);

  await ctx.render("edit_post", {
    ctx,
    post: post,
  });
});

// See and keep in sync with GET /posts/:id/edit
router.get("/pms/:id/edit", async (ctx: Context) => {
  // Short-circuit if user isn't logged in
  ctx.assert(ctx.currUser, 403);

  // Load the resource
  var pm = await db.findPmById(ctx.params.id).then(pre.presentPm);

  // 404 if it doesn't exist
  ctx.assert(pm, 404);

  // Ensure current user is authorized to edit it
  ctx.assertAuthorized(ctx.currUser, "UPDATE_PM", pm);

  await ctx.render("edit_pm", {
    ctx,
    pm: pm,
  });
});

//
// Update post markup (via from submission)
// This is for the /posts/:id/edit basic form made
// for people on devices where the Edit button doesn't work.
//
// Params: markup
router.put("/posts/:id", async (ctx: Context) => {
  const post = await db.findPostById(ctx.params.id).then(pre.presentPost);
  ctx.assert(post, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_POST", post);

  // Validation

  ctx
    .validateBody("markup")
    .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);

  ctx.validateBody("reason").optional().isString().trim().isLength(0, 300);

  // Succeeded

  // Short-circuit if nothing changed
  if (post.markup.trim() === ctx.vals.markup.trim()) {
    ctx.redirect(post.url);
    return;
  }

  // Render BBCode to html
  const html = bbcode(ctx.vals.markup);

  const updatedPost = await db
    .updatePost(
      ctx.currUser.id,
      post.id,
      ctx.vals.markup,
      html,
      ctx.vals.reason,
    )
    .then(pre.presentPost);

  ctx.response.redirect(updatedPost.url);

  // If it's the FAQ post, refresh cache
  if (post.id === config.FAQ_POST_ID) {
    cache3.requestUpdate("faq-post");
  }

  if (post.id === config.WELCOME_POST_ID) {
    cache3.requestUpdate("welcome-post");
  }

  // Check if post is spam after response is sent
  services.antispam.process(ctx, ctx.vals.markup, post.id);
});

// See and keep in sync with PUT /posts/:id
// Params: markup
router.put("/pms/:id", async (ctx: Context) => {
  ctx
    .validateBody("markup")
    .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);

  var pm = await db.findPmById(ctx.params.id);
  ctx.assert(pm, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_PM", pm);

  // Render BBCode to html
  var html = bbcode(ctx.vals.markup);

  var updatedPm = await db
    .updatePm(ctx.params.id, ctx.vals.markup, html)
    .then(pre.presentPm);

  ctx.response.redirect(updatedPm.url);
});

//
// Post markdown view
//
// Returns the unformatted post source.
//
router.get("/posts/:id/raw", async (ctx: Context) => {
  var post = await db.findPostWithTopicAndForum(ctx.params.id);
  ctx.assert(post, 404);
  ctx.assertAuthorized(ctx.currUser, "READ_POST", post);
  ctx.set("Cache-Control", "no-cache");
  ctx.set("X-Robots-Tag", "noindex");
  ctx.body = post.markup ? post.markup : post.text;
});

router.get("/pms/:id/raw", async (ctx: Context) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = "PM system currently disabled";
    return;
  }

  ctx.assert(ctx.currUser, 404);
  var pm = await db.findPmWithConvo(ctx.params.id);
  ctx.assert(pm, 404);
  ctx.assertAuthorized(ctx.currUser, "READ_PM", pm);
  ctx.set("Cache-Control", "no-cache");
  ctx.body = pm.markup ? pm.markup : pm.text;
});

//
// Update post markup
// Body params:
// - markup
// - reason (optional)
//
// Keep /api/posts/:postId and /api/pms/:pmId in sync
router.put("/api/posts/:id", async (ctx: Context) => {
  const post = await db.findPost(ctx.params.id);
  ctx.assert(post, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_POST", post);

  // Validation

  ctx
    .validateBody("markup")
    .isString()
    .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);

  ctx.validateBody("reason").optional().isString().trim().isLength(0, 300);

  // Succeeded

  ctx.type = "json";

  // Short-circuit if nothing changed
  if (post.markup.trim() === ctx.request.body.markup.trim()) {
    ctx.body = JSON.stringify(post);
    return;
  }

  // Render BBCode to html
  var html = bbcode(ctx.request.body.markup);

  var updatedPost = await db
    .updatePost(
      ctx.currUser.id,
      post.id,
      ctx.vals.markup,
      html,
      ctx.vals.reason,
    )
    .then(pre.presentPost);

  ctx.body = JSON.stringify(updatedPost);

  // If it's the FAQ post, refresh cache
  if (post.id === config.FAQ_POST_ID) {
    cache3.requestUpdate("faq-post");
  }

  if (post.id === config.WELCOME_POST_ID) {
    cache3.requestUpdate("welcome-post");
  }

  // TODO: Submit to spam service like PUT /posts/:id
});

router.put("/api/pms/:id", async (ctx: Context) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = "PM system currently disabled";
    return;
  }

  ctx
    .validateBody("markup")
    .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);

  // Users that aren't logged in can't read any PMs, so just short-circuit
  // if user is a guest so we don't even incur DB query.
  ctx.assert(ctx.currUser, 404);

  var pm = await db.findPmWithConvo(ctx.params.id);

  // 404 if there is no PM with this ID
  ctx.assert(pm, 404);

  // Ensure user is allowed to update this PM
  ctx.assertAuthorized(ctx.currUser, "UPDATE_PM", pm);

  // Render BBCode to html
  var html = bbcode(ctx.vals.markup);

  var updatedPm = await db
    .updatePm(ctx.params.id, ctx.vals.markup, html)
    .then(pre.presentPm);

  ctx.body = JSON.stringify(updatedPm);
});

//
// Update topic status
// Params
// - status (Required) String, one of STATUS_WHITELIST
//
router.put("/topics/:topicSlug/status", async (ctx: Context) => {
  var topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  var STATUS_WHITELIST = [
    "stick",
    "unstick",
    "hide",
    "unhide",
    "close",
    "open",
  ];
  var status = ctx.request.body.status;
  ctx.assert(STATUS_WHITELIST.includes(status), 400, "Invalid status");
  var topic = await db.findTopic(topicId);
  topic.mods = cache3.get("forum-mods")[topic.forum_id] || [];
  ctx.assert(topic, 404);
  var action = status.toUpperCase() + "_TOPIC";
  ctx.assertAuthorized(ctx.currUser, action, topic);
  await db.updateTopicStatus(topicId, status);
  ctx.flash = { message: ["success", "Topic updated"] };
  pre.presentTopic(topic);
  ctx.response.redirect(topic.url);
});

// Update post state
router.post("/posts/:postId/:status", async (ctx: Context) => {
  var STATUS_WHITELIST = ["hide", "unhide"];
  ctx.assert(
    STATUS_WHITELIST.includes(ctx.params.status),
    400,
    "Invalid status",
  );
  ctx.assert(ctx.currUser, 403);
  var post = await db.findPost(ctx.params.postId);
  ctx.assert(post, 404);
  ctx.assertAuthorized(
    ctx.currUser,
    ctx.params.status.toUpperCase() + "_POST",
    post,
  );
  var updatedPost = await db
    .updatePostStatus(ctx.params.postId, ctx.params.status)
    .then(pre.presentPost);

  ctx.response.redirect(updatedPost.url);
});

//
// Post permalink
// (Show post)
//
// Calculates pagination offset and redirects to
// canonical topic page since the page a post falls on depends on
// currUser. For example, members can't see most hidden posts while
// mods can.
// - Keep this in sync with /pms/:pmId
//
// If it has ?created=true query, then add it onto redirect:
// /posts/:id#post-:id&created=true
// and take it off client-side.
router.get("/posts/:postId", async (ctx: Context) => {
  // "/posts/1234]" is such a common issue that we should fix it
  ctx.params.postId = Number.parseInt(ctx.params.postId, 10);
  ctx.assert(ctx.params.postId, 404);

  var post = await db.findPostWithTopicAndForum(ctx.params.postId);
  ctx.assert(post, 404);

  // Instead of 404ing if a post has been hidden, keep the user in the
  // topic and tell them what happened
  //
  // TODO: Implement some sort of /topics/:id/last-post that does
  // a smart redirect, ignoring hidden posts.
  if (cancan.cannot(ctx.currUser, "READ_POST", post) && post.is_hidden) {
    ctx.flash = {
      message: [
        "warning",
        "The post you tried to navigate to has been hidden.",
      ],
    };
    ctx.redirect(`/topics/${post.topic_id}`);
    return;
  }

  ctx.assertAuthorized(ctx.currUser, "READ_POST", post);

  post = pre.presentPost(post);

  // Determine the topic url and page for this post
  var redirectUrl;
  if (post.idx < config.POSTS_PER_PAGE) {
    redirectUrl = post.topic.url + "/" + post.type + "#post-" + post.id;
  } else {
    redirectUrl =
      post.topic.url +
      "/" +
      post.type +
      "?page=" +
      Math.ceil((post.idx + 1) / config.POSTS_PER_PAGE) +
      "#post-" +
      post.id;
  }

  // Handle ?created=true
  if (ctx.query.created) {
    if (/#/.test(redirectUrl)) {
      redirectUrl += "&created=true";
    } else {
      redirectUrl += "#created=true";
    }
  }

  if (ctx.currUser) {
    // Delete notifications related to this post
    var notificationsDeletedCount = await db.deleteNotificationsForPostId(
      ctx.currUser.id,
      ctx.params.postId,
    );
    // Update the stale user
    ctx.currUser.notifications_count -= notificationsDeletedCount;
  }

  ctx.response.redirect(redirectUrl);
});

// PM permalink
// Keep this in sync with /posts/:postId
router.get("/pms/:id", async (ctx: Context) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = "PM system currently disabled";
    return;
  }

  ctx.assert(ctx.currUser, 404);
  var id = ctx.params.id;
  var pm = await db.findPmWithConvo(id);
  ctx.assert(pm, 404);
  ctx.assertAuthorized(ctx.currUser, "READ_PM", pm);

  pm = pre.presentPm(pm);

  var redirectUrl;
  if (pm.idx < config.POSTS_PER_PAGE) {
    redirectUrl = pm.convo.url + "#post-" + pm.id;
  } else {
    redirectUrl =
      pm.convo.url +
      "?page=" +
      Math.max(1, Math.ceil((pm.idx + 1) / config.POSTS_PER_PAGE)) +
      "#post-" +
      pm.id;
  }

  ctx.status = 301;
  ctx.response.redirect(redirectUrl);
});

// Add topic ban
//
// Body { uname: String }
router.post("/topics/:slug/bans", async (ctx: Context) => {
  const topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  const topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC", topic);

  if (topic.banned_ids && topic.banned_ids.length >= 10) {
    ctx.flash = {
      message: ["danger", "Cannot ban more than 10 users from a roleplay"],
    };
    ctx.redirect("back");
    return;
  }

  ctx.validateBody("uname").isString();
  const userToBan = await db
    .findUserByUname(ctx.vals.uname)
    .then(pre.presentUser);

  if (!userToBan) {
    ctx.flash = {
      message: ["danger", "Could not find user with that name"],
    };
    ctx.redirect("back");
    return;
  }

  ctx.assertAuthorized(ctx.currUser, "TOPIC_BAN", { topic, user: userToBan });

  await db.insertTopicBan(topic.id, ctx.currUser.id, userToBan.id);

  ctx.flash = { message: ["success", "User added to topic banlist"] };
  ctx.redirect(topic.url + "/edit#topic-bans");
});

router.delete("/topic-bans/:id", async (ctx: Context) => {
  ctx.validateParam("id").toInt();

  const ban = await db.getTopicBan(ctx.vals.id).then(pre.presentTopicBan);
  ctx.assert(404);

  const topic = await db.findTopicById(ban.topic_id).then(pre.presentTopic);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TOPIC", topic);

  await db.deleteTopicBan(ban.id);

  ctx.flash = { message: ["success", "Unbanned user from topic"] };
  ctx.redirect(topic.url + "/edit#topic-bans");
});

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
  var topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);
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
  var topic = await db.findTopicById(topicId);
  ctx.assert(topic, 404);
  topic = pre.presentTopic(topic);
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
  const topic = await db.findTopicById(topicId);
  ctx.assert(topic, 404);

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

  var topic;
  if (ctx.currUser) {
    topic = await db.findTopicWithIsSubscribed(ctx.currUser.id, topicId);
  } else {
    topic = await db.findTopicById(topicId);
  }
  ctx.assert(topic, 404);
  topic = pre.presentTopic(topic);

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
  var topic;
  if (ctx.currUser) {
    topic = await db.findTopicWithIsSubscribed(ctx.currUser.id, topicId);
  } else {
    topic = await db.findTopicById(topicId);
  }
  ctx.assert(topic, 404);

  topic = pre.presentTopic(topic);

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

  ctx.assertAuthorized(ctx.currUser, "READ_TOPIC", topic);

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

  topic.mods = cache3.get("forum-mods")[topic.forum_id] || [];

  if (ctx.currUser) {
    posts.forEach((post) => {
      var rating = post.ratings.find((x) => x.from_user_id === ctx.currUser.id);
      post.has_rated = rating;
    });
  }

  // Update watermark
  if (ctx.currUser && posts.length > 0) {
    await db
      .updateTopicWatermark({
        topic_id: topic.id,
        user_id: ctx.currUser.id,
        post_type: ctx.params.postType,
        post_id: _.last(posts).id,
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
  db.upsertViewer(ctx, topic.forum_id, topic.id).catch((err) =>
    console.error(err, err.stack),
  );

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

  var topic = await db.findTopic(topicId);
  ctx.assert(topic, 404);

  // If user cannot read topic and it's deleted, redirect them to
  // the forum and explain what happened
  if (cancan.cannot(ctx.currUser, "READ_TOPIC", topic) && topic.is_hidden) {
    ctx.flash = {
      message: [
        "warning",
        `
        The topic you tried to view has been hidden. It was possibly spam.
      `,
      ],
    };
    ctx.redirect(`/forums/${topic.forum_id}`);
    return;
  }

  ctx.assertAuthorized(ctx.currUser, "READ_TOPIC", topic);

  topic = pre.presentTopic(topic);

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

//
// Staff list
//
router.get("/staff", async (ctx: Context) => {
  const users = cache3.get("staff").map(pre.presentUser);

  await ctx.render("staff", {
    ctx,
    mods: users.filter((u) => u.role === "mod"),
    smods: users.filter((u) => u.role === "smod"),
    conmods: users.filter((u) => u.role === "conmod"),
    admins: users.filter((u) => u.role === "admin"),
    arena_mods: users.filter((u) => u.role === "arenamod"),
    pwmods: users.filter((u) => u.role === "pwmod"),
  });
});

//
// GET /me/notifications
// List currUser's notifications
//
router.get("/me/notifications", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);
  const notifications = await db
    .findReceivedNotificationsForUserId(ctx.currUser.id)
    .then((xs) => xs.map(pre.presentNotification));

  await ctx.render("me_notifications", {
    ctx,
    notifications,
  });
});

//
// Move topic
//
router.post("/topics/:slug/move", async (ctx: Context) => {
  const topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  let topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, "MOVE_TOPIC", topic);

  // Validation

  ctx
    .validateBody("forum-id")
    .toInt("forum-id required")
    .notEq(
      topic.forum_id,
      "Topic already belongs to the forum you tried to move it to",
    );
  console.log("redire", ctx.request.body);
  ctx.validateBody("leave-redirect?").tap((x) => x === "on");

  topic = await db
    .moveTopic(
      topic.id,
      topic.forum_id,
      ctx.vals["forum-id"],
      ctx.vals["leave-redirect?"],
    )
    .then(pre.presentTopic);

  ctx.flash = {
    message: ["success", "Topic moved"],
  };

  ctx.response.redirect(topic.url);
});

//
// Delete currUser's rating for a post
//
router.delete("/me/ratings/:postId", async (ctx: Context) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403);
  var rating = await db.findRatingByFromUserIdAndPostId(
    ctx.currUser.id,
    ctx.params.postId,
  );
  // Ensure rating exists
  ctx.assert(rating, 404);

  // Ensure rating was created within 30 seconds
  var thirtySecondsAgo = new Date(Date.now() - 1000 * 30);
  // If this user's previous rating is newer than 30 seconds ago, fail.
  if (rating.created_at < thirtySecondsAgo) {
    ctx.status = 400;
    ctx.body = "You cannot delete a rating that is older than 30 seconds";
    return;
  }

  await db.deleteRatingByFromUserIdAndPostId(
    ctx.currUser.id,
    ctx.params.postId,
  );

  ctx.response.redirect("/posts/" + ctx.params.postId);
});

/// /////////////////////////////////////////////////////////

router.get("/trophies", async (ctx: Context) => {
  ctx.body = "TODO";
});

// List all trophy groups
router.get("/trophy-groups", async (ctx: Context) => {
  var groups = await db.findTrophyGroups();

  await ctx.render("list_trophy_groups", {
    ctx,
    groups: groups,
  });
});

// Create trophy group
router.post("/trophy-groups", async (ctx: Context) => {
  // Authorize
  ctx.assertAuthorized(ctx.currUser, "CREATE_TROPHY_GROUP");

  ctx
    .validateBody("title")
    .isString("Title required")
    .trim()
    .isLength(3, 50, "Title must be 3-50 chars");

  ctx.validateBody("description-markup");
  if (ctx.request.body["description-markup"]) {
    ctx
      .validateBody("description-markup")
      .trim()
      .isLength(3, 3000, "Description must be 3-3000 chars");
  }

  var description_html;
  if (ctx.vals["description-markup"]) {
    description_html = bbcode(ctx.vals["description-markup"]);
  }

  await db.createTrophyGroup(
    ctx.vals.title,
    ctx.vals["description-markup"],
    description_html,
  );

  ctx.flash = { message: ["success", "Trophy group created"] };
  ctx.redirect("/trophy-groups");
});

// Update trophy-group
router.put("/trophy-groups/:id", async (ctx: Context) => {
  // Load
  var group = await db.findTrophyGroupById(ctx.params.id);
  ctx.assert(group, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TROPHY_GROUP", group);

  ctx.validateParam("id").toInt();

  ctx
    .validateBody("title")
    .isString("Title required")
    .trim()
    .isLength(3, 50, "Title must be 3-50 chars");

  ctx.validateBody("description-markup");
  if (ctx.request.body["description-markup"]) {
    ctx
      .validateBody("description-markup")
      .trim()
      .isLength(3, 3000, "Description must be 3-3000 chars");
  }

  var description_html;
  if (ctx.vals["description-markup"]) {
    description_html = bbcode(ctx.vals["description-markup"]);
  }

  await db.updateTrophyGroup(
    ctx.vals.id,
    ctx.vals.title,
    ctx.vals["description-markup"],
    description_html,
  );

  ctx.redirect("/trophy-groups/" + group.id);
});

// Delete active trophy
router.del("/users/:user_id/active-trophy", async (ctx: Context) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403);

  ctx.validateParam("user_id").toInt();

  // Ensure currUser is only trying to operate on themselves
  // TODO: Make cancan.js rule
  ctx.assert(ctx.currUser.id === ctx.vals.user_id, 403);

  // Ensure user exists
  const user = await db.findUserById(ctx.vals.user_id).then(pre.presentUser);
  ctx.assert(user, 404);

  // Deactivate trophy
  await db.deactivateCurrentTrophyForUserId(ctx.vals.user_id);

  // Redirect
  ctx.flash = { message: ["success", "Trophy deactivated"] };
  ctx.redirect(user.url);
});

// Update user active_trophy_id
//
// Body:
// - trophy_id: Required Int
router.put("/users/:user_id/active-trophy", async (ctx: Context) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403);

  ctx.validateParam("user_id").toInt();
  ctx.validateBody("trophy_id").isString("trophy_id required").toInt();

  // Ensure user exists
  const user = await db.findUserById(ctx.vals.user_id).then(pre.presentUser);
  ctx.assert(user, 404);

  // Ensure user owns this trophy
  const trophy = await db.findTrophyByIdAndUserId(ctx.vals.trophy_id, user.id);
  ctx.assert(trophy, 404);

  // Update user's active_trophy_id
  await db.updateUserActiveTrophyId(user.id, trophy.id);

  // Return user to profile
  ctx.flash = { message: ["success", "Trophy activated"] };
  ctx.redirect(user.url);
});

router.get("/trophy-groups/:id/edit", async (ctx: Context) => {
  // Load
  var group = await db.findTrophyGroupById(ctx.params.id);
  ctx.assert(group, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TROPHY_GROUP", group);

  await ctx.render("edit_trophy_group", {
    ctx,
    group: group,
  });
});

// Show trophies-users bridge record edit form
router.get("/trophies-users/:id/edit", async (ctx: Context) => {
  // Load
  var record = await db.findTrophyUserBridgeById(ctx.params.id);
  ctx.assert(record, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, "MANAGE_TROPHY_SYSTEM");

  await ctx.render("edit_trophies_users", {
    ctx,
    record: record,
  });
});

// Update trophies-users bridge record
router.put("/trophies-users/:id", async (ctx: Context) => {
  // Load
  var record = await db.findTrophyUserBridgeById(ctx.params.id);
  ctx.assert(record, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, "MANAGE_TROPHY_SYSTEM");

  ctx.validateParam("id").toInt();

  ctx.validateBody("message-markup");
  if (ctx.request.body["message-markup"]) {
    ctx
      .validateBody("message-markup")
      .trim()
      .isLength(3, 500, "Message must be 3-500 chars");
  }

  var message_html;
  if (ctx.vals["message-markup"]) {
    message_html = bbcode(ctx.vals["message-markup"]);
  }

  await db.updateTrophyUserBridge(
    ctx.vals.id,
    ctx.vals["message-markup"],
    message_html,
  );

  ctx.redirect("/trophies/" + record.trophy.id);
});

// Show trophy edit form
router.get("/trophies/:id/edit", async (ctx: Context) => {
  // Load
  var trophy = await db.findTrophyById(ctx.params.id);
  ctx.assert(trophy, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TROPHY", trophy);

  await ctx.render("edit_trophy", {
    ctx,
    trophy: trophy,
  });
});

// Update trophy
router.put("/trophies/:id", async (ctx: Context) => {
  // Load
  var trophy = await db.findTrophyById(ctx.params.id);
  ctx.assert(trophy, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, "UPDATE_TROPHY", trophy);

  ctx.validateParam("id").toInt();

  ctx
    .validateBody("title")
    .isString("Title required")
    .trim()
    .isLength(3, 50, "Title must be 3-50 chars");

  ctx.validateBody("description-markup");
  if (ctx.request.body["description-markup"]) {
    ctx
      .validateBody("description-markup")
      .trim()
      .isLength(3, 3000, "Description must be 3-3000 chars");
  }

  var description_html;
  if (ctx.vals["description-markup"]) {
    description_html = bbcode(ctx.vals["description-markup"]);
  }

  await db.updateTrophy(
    ctx.vals.id,
    ctx.vals.title,
    ctx.vals["description-markup"],
    description_html,
  );

  ctx.redirect("/trophies/" + trophy.id);
});

router.get("/trophy-groups/:id", async (ctx: Context) => {
  var group = await db.findTrophyGroupById(ctx.params.id);

  // Ensure group exists
  ctx.assert(group, 404);

  // Fetch trophies
  var trophies = await db.findTrophiesByGroupId(group.id);

  await ctx.render("show_trophy_group", {
    ctx,
    group: group,
    trophies: trophies,
  });
});

router.get("/trophies/:id", async (ctx: Context) => {
  const trophy = await db.findTrophyById(ctx.params.id).then(pre.presentTrophy);

  // Ensure trophy exists
  ctx.assert(trophy, 404);

  // Fetch winners
  const winners = await db.findWinnersForTrophyId(trophy.id);

  await ctx.render("show_trophy", {
    ctx,
    trophy: trophy,
    winners: winners,
  });
});

router.get("/refresh-homepage/:anchor_name", async (ctx: Context) => {
  ctx.set("X-Robots-Tag", "none");
  ctx.status = 301;
  ctx.redirect(util.format("/#%s", ctx.params.anchor_name));
});

router.get("/current-feedback-topic", async (ctx: Context) => {
  // ensure user is logged in and admin
  ctx.assert(ctx.currUser && ctx.currUser.role === "admin", 403);
  // ensure a feedback topic is set
  if (!config.CURRENT_FEEDBACK_TOPIC_ID) {
    ctx.body = "CURRENT_FEEDBACK_TOPIC_ID is not set";
    return;
  }

  // Load ftopic
  var ftopic = await db.findFeedbackTopicById(config.CURRENT_FEEDBACK_TOPIC_ID);
  ctx.assert(ftopic, 404);
  var replies = await db.findFeedbackRepliesByTopicId(
    config.CURRENT_FEEDBACK_TOPIC_ID,
  );

  await ctx.render("show_feedback_topic", {
    ctx,
    ftopic,
    replies,
  });
});

// text: String
router.post("/current-feedback-topic/replies", async (ctx: Context) => {
  // user must be logged in
  ctx.assert(ctx.currUser, 403);
  // user must not be banned
  ctx.assert(ctx.currUser.banned !== "banned", 403);
  // ensure a feedback topic is set
  ctx.assert(config.CURRENT_FEEDBACK_TOPIC_ID, 404);
  // ensure user hasn't already acked the ftopic
  var ftopic = await db.findUnackedFeedbackTopic(
    config.CURRENT_FEEDBACK_TOPIC_ID,
    ctx.currUser.id,
  );
  ctx.assert(ftopic, 404);

  // Validate form
  ctx.validateBody("commit").isIn(["send", "ignore"]);
  if (ctx.vals.commit === "send") {
    ctx
      .validateBody("text")
      .trim()
      .isLength(0, 3000, "Message may be up to 3000 chars");
  }

  await db.insertReplyToUnackedFeedbackTopic(
    ftopic.id,
    ctx.currUser.id,
    ctx.vals.text,
    ctx.vals.commit === "ignore",
  );

  ctx.flash = { message: ["success", "Thanks for the feedback <3"] };
  ctx.redirect("/");
});

router.get("/chat", async (ctx: Context) => {
  await ctx.render("chat", {
    ctx,
    session_id: ctx.state.session_id,
    chat_server_url: config.CHAT_SERVER_URL,
    //
    title: "Chat",
  });
});

/// /////////////////////////////////////////////////////////

/// /////////////////////////////////////////////////////////
// current_sidebar_contests

// Show the current-sidebar-contest form which is what's displayed
// on the Current Contest sidebar panel
router.get("/current-sidebar-contest", async (ctx: Context) => {
  // Ensure user is an admin or conmod
  ctx.assert(
    ctx.currUser && ["admin", "conmod"].includes(ctx.currUser.role),
    404,
  );

  var currentContest = await db.getCurrentSidebarContest();

  await ctx.render("current_sidebar_contest_show", {
    ctx,
    currentContest: currentContest,
  });
});

// Show create form
router.get("/current-sidebar-contest/new", async (ctx: Context) => {
  // Ensure user is an admin or conmod
  ctx.assert(
    ctx.currUser && ["admin", "conmod"].includes(ctx.currUser.role),
    404,
  );

  await ctx.render("current_sidebar_contest_new", { ctx });
});

// Show edit form
router.get("/current-sidebar-contest/edit", async (ctx: Context) => {
  // Ensure user is an admin or conmod
  ctx.assert(
    ctx.currUser && ["admin", "conmod"].includes(ctx.currUser.role),
    404,
  );

  var currentContest = await db.getCurrentSidebarContest();

  // Can only go to /edit if there's actually a contest to edit
  if (!currentContest) {
    ctx.flash = {
      message: [
        "danger",
        "There is no current contest to edit. Did you want to create a new one?",
      ],
    };
    ctx.redirect("/current-sidebar-contest");
    return;
  }

  await ctx.render("current_sidebar_contest_edit", {
    ctx,
    currentContest: currentContest,
  });
});

// Update current contest
//
// Keep in sync with the POST (creation) route
router.put("/current-sidebar-contest", async (ctx: Context) => {
  // Ensure user is an admin or conmod
  ctx.assert(
    ctx.currUser && ["admin", "conmod"].includes(ctx.currUser.role),
    404,
  );

  // Validation

  ctx.validateBody("title").isString().trim();
  ctx
    .validateBody("topic_url")
    .isString()
    .tap((s) => s.trim());
  ctx
    .validateBody("deadline")
    .isString()
    .tap((s) => s.trim());
  ctx.validateBody("image_url").tap((url) => url || undefined);

  // Ensure there is a current contest to update

  var currentContest = await db.getCurrentSidebarContest();

  // Can only update if there's actually a contest to edit
  if (!currentContest) {
    ctx.flash = {
      message: [
        "danger",
        "There is no current contest to update. If you encounter this message, can you tell Mahz what you did to get here? Because you should not see this message under normal circumstances.",
      ],
    };
    ctx.redirect("/current-sidebar-contest");
    return;
  }

  // Save the changes to the current contest

  await db.updateCurrentSidebarContest(currentContest.id, {
    title: ctx.vals.title,
    topic_url: ctx.vals.topic_url,
    deadline: ctx.vals.deadline,
    image_url: ctx.vals.image_url,
  });

  ctx.flash = { message: ["success", "Contest updated"] };
  ctx.redirect("/current-sidebar-contest");
});

// Create new sidebar contest
router.post("/current-sidebar-contest", async (ctx: Context) => {
  // Ensure user is an admin or conmod
  ctx.assert(
    ctx.currUser && ["admin", "conmod"].includes(ctx.currUser.role),
    404,
  );

  // Validation

  ctx
    .validateBody("title")
    .isString()
    .tap((s) => s.trim());
  ctx
    .validateBody("topic_url")
    .isString()
    .tap((s) => s.trim());
  ctx
    .validateBody("deadline")
    .isString()
    .tap((s) => s.trim());
  ctx.validateBody("image_url").tap((url) => url || undefined);

  await db.insertCurrentSidebarContest({
    title: ctx.vals.title,
    topic_url: ctx.vals.topic_url,
    deadline: ctx.vals.deadline,
    image_url: ctx.vals.image_url,
  });

  ctx.flash = { message: ["success", "Current contest created"] };
  ctx.redirect("/current-sidebar-contest");
});

router.del("/current-sidebar-contest", async (ctx: Context) => {
  // Ensure user is an admin or conmod
  ctx.assert(
    ctx.currUser && ["admin", "conmod"].includes(ctx.currUser.role),
    404,
  );

  await db.clearCurrentSidebarContest();

  ctx.flash = { message: ["success", "Current contest cleared"] };
  ctx.redirect("/current-sidebar-contest");
});

/// ////////////////////////////////////////////////////////

guildbot.connect().catch((err) => console.error("guildbot error", err));

/// /////////////////////////////////////////////////////////

app.use(router.routes());

cache3.on("error", (err) => {
  console.error("cache3 error", err);
});

console.log("Waiting for cache3 to be ready before starting server...");
cache3.start();
cache3.waitUntilReady().then(() => {
  app.listen(config.PORT, () => {
    console.log("Listening on", config.PORT);
  });
});
