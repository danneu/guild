"use strict";

import checkCloudflareTurnstile from "../middleware/cloudflare-turnstile";

// Node
import util from "util";
// 3rd party
import Router from "@koa/router";
import _ from "lodash";
import createDebug from "debug";
const debug = createDebug("app:routes:users");
import assert from "assert";
// 1st party
import * as db from "../db";
import * as belt from "../belt";
import * as pre from "../presenters";
import * as config from "../config";
import * as cancan from "../cancan";
import * as avatar from "../avatar";
import bbcode from "../bbcode";
import services from "../services";
import {
  broadcastManualNuke,
  broadcastManualUnnuke,
  broadcastBioUpdate,
} from "../services/discord";
import cache2 from "../cache2";
import ipintel from "../services/ipintel";
import { Context, Next } from "koa";

const router = new Router();

////////////////////////////////////////////////////////////
// Middleware helpers

// redirectTemplate looks like /users/<>/edit
// if redirectTemplate is not given, we will not redirect
// on slug mismatch
function loadUserFromSlug(
  key: string,
  redirectTemplate: string | undefined = undefined,
) {
  assert(typeof key === "string");
  if (redirectTemplate) {
    assert(typeof redirectTemplate === "string");
    assert(redirectTemplate.includes("<>"));
  }

  return async (ctx: Context, next: Next) => {
    const slug = ctx.params[key];
    ctx.assert(slug, 404);

    const user = await db.findUserBySlug(slug).then(pre.presentUser);
    ctx.assert(user, 404);

    // If url slug does not match user.slug, then this is
    // a historic slug and we should redirect
    if (redirectTemplate && slug !== user.slug) {
      ctx.redirect(redirectTemplate.replace("<>", user.slug));
      return;
    }

    ctx.state.user = user;
    return next();
  };
}

////////////////////////////////////////////////////////////

// Show user alternate accounts
//
router.get(
  "/users/:slug/alts",
  loadUserFromSlug("slug"),
  async (ctx: Context) => {
    ctx.body = "temp disabled";
    return;

    // ctx.assert(ctx.currUser && cancan.isStaffRole(ctx.currUser.role), 403)

    // const { user } = ctx.state

    // const alts = await db.hits.findAltsFromUserId(user.id)

    // // TODO: Make presenter
    // alts.forEach(alt => {
    //     pre.presentUser(alt.user)
    // })

    // await ctx.render('list_user_alts', {
    //     ctx,
    //     alts,
    //     user,
    // })
  },
);

////////////////////////////////////////////////////////////

//
// Edit user
//
// @koa2
router.get(
  "/users/:slug/edit",
  loadUserFromSlug("slug", "/users/<>/edit"),
  async (ctx: Context) => {
    const { user } = ctx.state;
    ctx.assertAuthorized(ctx.currUser, "UPDATE_USER", user);

    const lastUnameChange = await db.unames.lastUnameChange(user.id);
    ctx.assert(
      lastUnameChange,
      400,
      "Unexpected: User should have at least one uname change",
    );

    const eligibleForUnameChange =
      cancan.isStaffRole(ctx.currUser.role) ||
      // If change_by_id is falsey, then this is the user's first uname history item (initial uname)
      !lastUnameChange.changed_by_id ||
      belt.isOlderThan(lastUnameChange.created_at, { months: 3 });

    await ctx.render("edit_user", {
      ctx,
      user,
      lastUnameChange,
      eligibleForUnameChange,
      title: "Edit " + user.uname,
    });
  },
);

////////////////////////////////////////////////////////////

// Update uname
//
// Body:
// - uname
router.post("/users/:slug/unames", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);
  let user = await db.findUserBySlug(ctx.params.slug).then(pre.presentUser);
  ctx.assert(user, 404);
  ctx.assertAuthorized(ctx.currUser, "CHANGE_UNAME", user);

  // Sync with create-user endpoint
  ctx
    .validateBody("uname")
    .isString("Username required")
    .tap((s) => s.trim())
    .isLength(
      config.MIN_UNAME_LENGTH,
      config.MAX_UNAME_LENGTH,
      "Username must be " +
        config.MIN_UNAME_LENGTH +
        "-" +
        config.MAX_UNAME_LENGTH +
        " characters",
    )
    .match(/^[a-z0-9 ]+$/i, "Username must only contain a-z, 0-9, and spaces")
    .match(/[a-z]/i, "Username must contain at least one letter (a-z)")
    .notMatch(/^[-]/, "Username must not start with hyphens")
    .notMatch(/[-]$/, "Username must not end with hyphens")
    .notMatch(/[ ]{2,}/, "Username contains consecutive spaces")
    .checkNot(await db.findUserByUname(ctx.vals.uname), "Username taken");

  // Only admins can set recycle
  if (ctx.currUser.role === "admin") {
    ctx.validateBody("recycle").toBoolean();
  }

  try {
    user = await db.unames
      .changeUname({
        userId: user.id,
        changedById: ctx.currUser.id,
        oldUname: user.uname,
        newUname: ctx.vals.uname,
        recycle: ctx.vals.recycle,
      })
      .then(pre.presentUser);
  } catch (err) {
    if (err === "UNAME_TAKEN") {
      ctx.flash = { message: ["danger", "Username taken"] };
      ctx.redirect(user.url + "/edit");
      return;
    }
    throw err;
  }

  ctx.flash = { message: ["success", "Username updated"] };
  ctx.redirect(user.url);
});

////////////////////////////////////////////////////////////

//
// Create new user
// - uname
// - password1
// - password2
// - email
// - cf-turnstile-response
//
// @koa2
router.post("/users", checkCloudflareTurnstile, async (ctx: Context) => {
  if (!(await db.keyvals.getValueByKey("REGISTRATION_ENABLED"))) {
    return ctx.redirect("/register");
  }

  // Validation

  ctx
    .validateBody("uname")
    .isString("Username required")
    .tap((s) => s.trim())
    .isLength(
      config.MIN_UNAME_LENGTH,
      config.MAX_UNAME_LENGTH,
      "Username must be " +
        config.MIN_UNAME_LENGTH +
        "-" +
        config.MAX_UNAME_LENGTH +
        " characters",
    )
    .match(/^[a-z0-9 ]+$/i, "Username must only contain a-z, 0-9, and spaces")
    .match(/[a-z]/i, "Username must contain at least one letter (a-z)")
    .notMatch(/^[-]/, "Username must not start with hyphens")
    .notMatch(/[-]$/, "Username must not end with hyphens")
    .notMatch(/[ ]{2,}/, "Username contains consecutive spaces")
    .checkNot(await db.findUserByUname(ctx.vals.uname), "Username taken");
  ctx
    .validateBody("email")
    .isEmail("Email must be valid")
    .checkNot(await db.findUserByEmail(ctx.vals.email), "Email taken");
  ctx.validateBody("password2").isString("Password confirmation required");
  ctx
    .validateBody("password1")
    .isString("Password required")
    .isLength(6, 100, "Password must be at least 6 chars long")
    .eq(ctx.vals.password2, "Password confirmation must match");

  // User params validated, so create a user and log them in
  let user;
  let session;
  let errMessage;
  try {
    ({ user, session } = await db.createUserWithSession({
      uname: ctx.vals.uname,
      email: ctx.vals.email,
      password: ctx.vals.password1,
      ipAddress: ctx.request.ip,
    }));
  } catch (ex) {
    switch (ex) {
      case "UNAME_TAKEN":
        errMessage = "Username is taken";
        break;
      case "EMAIL_TAKEN":
        errMessage = "Email is taken";
        break;
      default:
        throw ex;
    }
  }

  pre.presentUser(user);

  if (errMessage) {
    ctx.flash = {
      message: ["danger", errMessage],
      params: ctx.request.body,
    };
    return ctx.response.redirect("/register");
  }

  // Log in the user
  ctx.cookies.set("sessionId", session.id, {
    expires: belt.futureDate({ years: 1 }),
  });

  // Send user the introductory PM
  // quirk: welcome-post can point to a post that has no html/markup if the post is ancient
  const welcomePost = cache2.get("welcome-post");
  if (
    config.STAFF_REPRESENTATIVE_ID &&
    welcomePost &&
    welcomePost.markup &&
    welcomePost.html
  ) {
    const { markup, html } = welcomePost;
    const convo = await db.createConvo({
      userId: config.STAFF_REPRESENTATIVE_ID,
      toUserIds: [user.id],
      title: "RPGuild Welcome Package",
      markup,
      html,
    });

    // Create CONVO notification
    await db.createConvoNotification({
      from_user_id: config.STAFF_REPRESENTATIVE_ID,
      to_user_id: user.id,
      convo_id: convo.id,
    });
  }

  // Broadcast user join to Discord #staff-only
  services.discord
    .broadcastUserJoin(user)
    .catch((err) => console.error("broadcastUserJoin failed", err));

  // In background, see if user is using a bad IP address
  const ipAddress =
    config.NODE_ENV === "development" && ctx.cookies.get("ip-override")
      ? ctx.cookies.get("ip-override")
      : ctx.ip;

  ipintel
    .process(ipAddress, user)
    .catch((err) => console.error("ipintel.process failed", err));

  ctx.flash = { message: ["success", "Registered successfully"] };
  return ctx.response.redirect("/");
});

//// TODO: DRY up all of these individual PUT routes
//// While I like the simplicity of individual logic per route,
//// it introduces syncing overhead between the implementations

//
// Update user role
//
// @koa2
router.put("/users/:slug/role", async (ctx: Context) => {
  ctx
    .validateBody("role")
    .isIn(
      [
        "banned",
        "member",
        "mod",
        "conmod",
        "arenamod",
        "pwmod",
        "smod",
        "admin",
      ],
      "Invalid role",
    );
  // TODO: Authorize role param against role of both parties
  const user = await db.findUserBySlug(ctx.params.slug);
  ctx.assert(user, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_USER_ROLE", user);

  // smod can set any roles except admin/smod
  if (ctx.currUser.role === "smod") {
    ctx
      .validateBody("role")
      .isIn(["banned", "member", "conmod", "mod", "pwmod"], "Invalid role");
  } else if (ctx.currUser.role === "mod") {
    // mod can only set roles to pwmod, member, and below
    ctx
      .validateBody("role")
      .isIn(["banned", "member", "pwmod"], "Invalid role");
  }

  await db.updateUserRole(user.id, ctx.request.body.role);
  pre.presentUser(user);
  ctx.flash = { message: ["success", "User role updated"] };
  ctx.response.redirect(user.url + "/edit");
});

////////////////////////////////////////////////////////////

// Delete legacy sig
router.delete("/users/:slug/legacy-sig", async (ctx: Context) => {
  const user = await db.findUserBySlug(ctx.params.slug);
  ctx.assert(user, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_USER", user);
  await db.deleteLegacySig(user.id);
  ctx.flash = { message: ["success", "Legacy sig deleted"] };
  ctx.response.redirect("/users/" + ctx.params.slug + "/edit");
});

////////////////////////////////////////////////////////////

// Change user's bio_markup via ajax
// Params:
// - markup: String
//
// @koa2
router.put("/api/users/:id/bio", async (ctx: Context) => {
  // Validation markup
  ctx
    .validateBody("markup")
    .trim()
    .isLength(
      0,
      config.MAX_BIO_LENGTH,
      `Bio must be 0-${config.MAX_BIO_LENGTH} chars`,
    );

  const user = await db.findUserById(ctx.params.id);
  ctx.assert(user, 404);

  // Ensure currUser has permission to update user
  ctx.assertAuthorized(ctx.currUser, "UPDATE_USER", user);

  // Ensure they have at least one post and an avatar_url
  if (ctx.currUser.role === "member") {
    ctx.assert(ctx.currUser.posts_count > 0 && ctx.currUser.avatar_url, 403);
  }

  // Validation succeeded
  // Render markup to html
  var html = "";
  if (ctx.request.body.markup.length > 0) {
    html = bbcode(ctx.request.body.markup);
  }

  // Save markup and html
  const updatedUser = await db.updateUserBio(
    user.id,
    ctx.request.body.markup,
    html,
  );

  ctx.body = JSON.stringify(updatedUser);

  // Broadcast to Discord if they are setting their bio (not just making an edit)
  // and they only have a couple posts
  const bioSet = !user.bio_markup && updatedUser.bio_markup;
  if (user.posts_count <= 2 && bioSet) {
    broadcastBioUpdate(user, updatedUser.bio_markup).catch((err) =>
      console.error("broadcastBioUpdate error", err),
    );
  }
});

//
// Update user
//
// This is a generic update route for updates that only need the
// UPDATE_USER cancan authorization check. In other words, this is
// a generic update route for updates that don't have complex logic
// or authorization checks
//
// At least one of these updates:
// - email
// - avatar-url
// - sig (which will pre-render sig_html field)
// - hide-sigs
// - hide-avatars
// - is-ghost
// - custom-title
// - is-grayscale
// - force-device-width
//
// @koa2
router.put("/users/:slug", async (ctx: Context) => {
  debug("BEFORE", ctx.request.body);

  ctx
    .validateBody("eflags")
    .optional()
    .defaultTo([])
    .isArray()
    .tap((xs) => xs.map((x) => Number.parseInt(x, 2)).filter(Boolean))
    .tap((xs) => xs.reduce((acc, curr) => acc | curr, 0));

  ctx.validateBody("email").optional().isEmail("Invalid email address");
  ctx.validateBody("sig").optional();
  ctx.validateBody("avatar-url").optional();

  if (typeof ctx.request.body["custom-title"] === "string") {
    ctx
      .validateBody("custom-title")
      .tap((s) => s.trim())
      .isLength(
        0,
        50,
        "custom-title can be up to 50 chars. Yours was " +
          ctx.request.body["custom-title"].length +
          ".",
      );
  }
  if (
    ctx.request.body["avatar-url"] &&
    ctx.request.body["avatar-url"].length > 0
  )
    ctx
      .validateBody("avatar-url")
      .tap((s) => s.trim())
      .isUrl("Must specify a URL for the avatar");
  // Coerce checkboxes to bool only if they are defined
  if (!_.isUndefined(ctx.request.body["hide-sigs"]))
    ctx.validateBody("hide-sigs").tap((x) => x !== "off");
  if (!_.isUndefined(ctx.request.body["hide-avatars"]))
    ctx.validateBody("hide-avatars").tap((x) => x !== "off");
  if (!_.isUndefined(ctx.request.body["is-ghost"]))
    ctx.validateBody("is-ghost").tap((x) => x !== "off");
  if (!_.isUndefined(ctx.request.body["is-grayscale"]))
    ctx.validateBody("is-grayscale").tap((x) => x !== "off");
  if (!_.isUndefined(ctx.request.body["force-device-width"]))
    ctx.validateBody("force-device-width").tap((x) => x !== "off");

  debug("AFTER", ctx.request.body);
  debug(ctx.vals);

  var user = await db.findUserBySlug(ctx.params.slug);
  ctx.assert(user, 404);
  ctx.assertAuthorized(ctx.currUser, "UPDATE_USER", user);

  var sig_html, sig_markup;
  // User is only updating their sig if `sig` is a string.
  // If it's a blank string, then user is trying to clear their sig
  if (_.isString(ctx.request.body.sig))
    if (ctx.request.body.sig.trim().length > 0) {
      sig_html = bbcode(ctx.request.body.sig);
      sig_markup = ctx.request.body.sig.trim();
    } else {
      sig_html = "";
      sig_markup = "";
    }

  // TODO: use db.users.updateUser

  // Reset email_verified when email is changed.
  const email_verified =
    typeof ctx.vals.email === "string" && ctx.vals.email !== user.email
      ? false
      : user.email_verified;

  try {
    await db.updateUser(user.id, {
      email: ctx.vals.email || user.email,
      email_verified,
      sig: sig_markup,
      sig_html: sig_html,
      custom_title: ctx.vals["custom-title"],
      avatar_url: ctx.request.body["avatar-url"],
      hide_sigs: _.isBoolean(ctx.vals["hide-sigs"])
        ? ctx.vals["hide-sigs"]
        : user.hide_sigs,
      hide_avatars: _.isBoolean(ctx.vals["hide-avatars"])
        ? ctx.vals["hide-avatars"]
        : user.hide_avatars,
      is_ghost: _.isBoolean(ctx.vals["is-ghost"])
        ? ctx.vals["is-ghost"]
        : user.is_ghost,
      is_grayscale: _.isBoolean(ctx.vals["is-grayscale"])
        ? ctx.vals["is-grayscale"]
        : user.is_grayscale,
      force_device_width: _.isBoolean(ctx.vals["force-device-width"])
        ? ctx.vals["force-device-width"]
        : user.force_device_width,
      // eflags: typeof ctx.vals.eflags === 'undefined' ? user.eflags : ctx.vals.eflags
      eflags: ctx.vals.eflags,
    });
  } catch (err) {
    if (err === "EMAIL_TAKEN") {
      ctx.flash = {
        message: [
          "danger",
          `The email <${
            ctx.vals.email
          }> is already in use. Send a PM to Mahz if you want an email address migrated to this account.`,
        ],
      };
      ctx.redirect("back");
      return;
    }
    throw err;
  }
  user = pre.presentUser(user);
  ctx.flash = { message: ["success", "User updated"] };
  ctx.response.redirect(user.url + "/edit");
});

//
// Search users
// checked
router.get("/users", async (ctx: Context) => {
  ctx.assertAuthorized(ctx.currUser, "READ_USER_LIST");

  // undefined || String
  ctx
    .validateQuery("text")
    .optional()
    .isLength(3, 15, "Username must be 3-15 chars");
  ctx.validateQuery("before-id").optional().toInt(); // undefined || Number

  /* if (ctx.errors) {
   *   ctx.flash = {
   *     message: ['danger', belt.joinErrors(ctx.errors)],
   *     params: ctx.request.body
   *   };
   *   ctx.response.redirect('/users');
   *   return;
   * }
   */
  var usersList: any[] = [];
  if (ctx.query["before-id"]) {
    if (ctx.query["text"]) {
      usersList = await db.findUsersContainingStringWithId(
        ctx.vals["text"],
        ctx.vals["before-id"],
      );
    } else {
      usersList = await db.paginateUsers(ctx.vals["before-id"]);
    }
  } else if (ctx.vals["text"]) {
    usersList = await db.findUsersContainingString(ctx.vals["text"]);
  } else {
    usersList = await db.paginateUsers();
  }

  usersList.forEach(pre.presentUser);

  const nextBeforeId = _.last(usersList) ? _.last(usersList).id : null;

  ctx.set("X-Robots-Tag", "noindex");

  await ctx.render("search_users", {
    ctx,
    term: ctx.query["text"],
    title: "Search Users",
    usersList,
    // Pagination
    beforeId: ctx.query["before-id"],
    nextBeforeId,
    usersPerPage: config.USERS_PER_PAGE,
  });
});

//
// Show user
//
// Legacy URLs look like /users/42
// We want to redirect those URLs to /users/some-username
// The purpose of this effort is to not break old URLs, but rather
// redirect them to the new URLs
router.get("/users/:userIdOrSlug", async (ctx: Context) => {
  // If param is all numbers, then assume it's a user-id.
  // Note: There are some users in the database with only digits in their name
  // which is not possible anymore since unames require at least one a-z letter.
  let user;
  if (/^\d+$/.test(ctx.params.userIdOrSlug)) {
    // First, see if it's one of the users with all-digit usernames (legacy)
    user = await db.findUserBySlug(ctx.params.userIdOrSlug);

    if (user && user.slug !== ctx.params.userIdOrSlug) {
      ctx.redirect("/users/" + user.slug);
      return;
    }

    // Then we see if it's an ID
    if (!user) {
      user = await db.findUser(ctx.params.userIdOrSlug);
      ctx.assert(user, 404);
      ctx.redirect("/users/" + user.slug);
      return;
    }
  }

  ctx.validateQuery("before-id").optional().toInt(); // will be undefined or number
  var userId = ctx.params.userIdOrSlug;

  // FIXME: Keep in sync with cancan READ_USER_RATINGS_TABLE
  // If currUser is a guest or if currUser is
  if (
    ctx.currUser &&
    (cancan.isStaffRole(ctx.currUser.role) || ctx.currUser.slug === userId)
  )
    user = await db.findUserWithRatingsBySlug(userId);
  else user = await db.findUserBySlug(userId);
  // Ensure user exists
  ctx.assert(user, 404);
  user = pre.presentUser(user);

  if (user.slug !== ctx.params.userIdOrSlug) {
    ctx.redirect("/users/" + user.slug);
    return;
  }

  // OPTIMIZE: Merge into single query?
  var recentPosts = await db.findRecentPostsForUserId(
    user.id,
    ctx.vals["before-id"],
  );
  // TODO: Figure out how to do this so I'm not possibly serving empty or
  //       partial pages since they're being filtered post-query.
  // Filter out posts that currUser is unauthorized to see
  recentPosts = recentPosts.filter((post) => {
    return cancan.can(ctx.currUser, "READ_POST", post);
  });
  recentPosts = recentPosts.map(pre.presentPost);

  // FIXME: Way too many queries in this route.

  // Only show members in the profile viewers list, esp. not staff or banned.
  if (
    ctx.currUser &&
    ctx.currUser.id !== user.id &&
    ctx.currUser.role === "member"
  ) {
    // insert in the background
    db.profileViews
      .insertView(ctx.currUser.id, user.id)
      .catch((err) => console.error("insertView error", err, err.stack));
  }

  const [statuses, friendship, latestViewers, unames] = await Promise.all([
    db.findLatestStatusesForUserId(user.id),
    ctx.currUser ? db.findFriendshipBetween(ctx.currUser.id, user.id) : null,
    db.profileViews
      .getLatestViews(user.id)
      .then((xs) => xs.map(pre.presentUser)),
    db.unames.userUnameHistory(user.id),
  ]);

  // Array<string | UnameHistoryItem>
  const unamesCloaked =
    // Only reveal name changes within past year (privacy) unless currUser is staff.
    ctx.currUser && cancan.isStaffRole(ctx.currUser.role)
      ? unames
      : unames.map((x, i) =>
          i === 0
            ? x
            : belt.isOlderThan(x.created_at, { years: 1 })
              ? { ...x, uname: x.uname.replace(/./g, "█"), cloaked: true }
              : x,
        );

  // Load approval if currUser can see it
  const approver =
    ctx.currUser && cancan.isStaffRole(ctx.currUser.role)
      ? await db.findUserById(user.approved_by_id).then(pre.presentUser)
      : null;

  // The ?before-id=_ of the "Next" button. i.e. the lowest
  // id of the posts on the current page
  const nextBeforeId = recentPosts.length > 0 ? _.last(recentPosts).id : null;

  ctx.set("Link", util.format('<%s>; rel="canonical"', config.HOST + user.url));

  // For view
  user.posts_per_day = (
    user.posts_count / (belt.daysAgo(user.created_at) || 1)
  ).toFixed(2);

  await ctx.render("show_user", {
    ctx,
    user,
    unamesCloaked,
    recentPosts,
    title: user.uname,
    statuses,
    currStatus: statuses.find((x) => x.id === user.current_status_id),
    friendship,
    approver,
    latestViewers,
    // Pagination
    nextBeforeId,
    recentPostsPerPage: config.RECENT_POSTS_PER_PAGE,
  });
});

//
// Show user trophies
//
// TODO: Sync up with regular show-user route
router.get("/users/:slug/trophies", async (ctx: Context) => {
  const user = await db
    .findUserWithRatingsBySlug(ctx.params.slug)
    .then(pre.presentUser);
  ctx.assert(user, 404);

  // TODO: Merge this query into the findUser query
  // Until then, only execute query if user's column cache indicates that
  // they actually have trophies
  let trophies =
    user.trophy_count === 0
      ? []
      : (await db.findTrophiesForUserId(user.id))
          // Hide anon trophies from their list
          // TODO: Display anon trophies as a mysterious trophy
          .filter((t) => !t.is_anon)
          .map(pre.presentTrophy);

  trophies = _.sortBy(trophies, [
    // Put the activeTrophy on top if there is one
    (t) => (t.id === user.active_trophy_id ? 0 : 1),
    // Sort the rest by newest first
    (t) => -t.awarded_at,
  ]);

  const [statuses, friendship] = await Promise.all([
    db.findLatestStatusesForUserId(user.id),
    ctx.currUser ? db.findFriendshipBetween(ctx.currUser.id, user.id) : null,
  ]);

  await ctx.render("show_user_trophies", {
    ctx,
    user,
    trophies,
    statuses,
    currStatus: statuses.find((x) => x.id === user.current_status_id),
    friendship,
  });
});

//
// Show user's VM
//
// This route is for use on the /me/notifications page since it
// will clear the notification for this VM
router.get("/me/vms/:id", async (ctx: Context) => {
  ctx.assert(ctx.currUser && ctx.currUser.role !== "banned");

  ctx.validateParam("id").toInt();
  await db.clearVmNotification(ctx.currUser.id, ctx.vals.id);

  ctx.redirect(
    "/users/" +
      (await db.vms.getVmById(ctx.vals.id)).to_user.slug +
      "/vms#vm-" +
      ctx.vals.id,
  );
});

////////////////////////////////////////////////////////////

// Delete VM
router.delete("/vms/:id", async (ctx: Context) => {
  ctx.validateParam("id").toInt();
  const vm = await db.vms.getVmById(ctx.vals.id).then(pre.presentVm);
  ctx.assert(vm, 404);
  ctx.assertAuthorized(ctx.currUser, "DELETE_VM", vm);

  // Delete VM
  await db.vms.deleteVm(vm.id);
  // And any notifications it caused
  await db.vms.deleteNotificationsForVmId(vm.id);
  // And all of its children
  await db.vms.deleteVmChildren(vm.id);

  // Delete any notifications that this VM caused

  ctx.flash = { message: ["success", "VM deleted"] };
  ctx.redirect(vm.to_user.url + "/vms#tabs");
});

////////////////////////////////////////////////////////////

//
// Show user visitor messages
//
// TODO: Sync up with regular show-user route
router.get("/users/:slug/vms", async (ctx: Context) => {
  const user = await db
    .findUserWithRatingsBySlug(ctx.params.slug)
    .then(pre.presentUser);
  ctx.assert(user, 404);

  const [statuses, friendship, vms] = await Promise.all([
    db.findLatestStatusesForUserId(user.id),
    ctx.currUser ? db.findFriendshipBetween(ctx.currUser.id, user.id) : null,
    db.findLatestVMsForUserId(user.id).then((xs) => xs.map(pre.presentVm)),
  ]);

  await ctx.render("show_user_visitor_messages", {
    ctx,
    user,
    vms,
    statuses,
    currStatus: statuses.find((x) => x.id === user.current_status_id),
    friendship,
  });
});

////////////////////////////////////////////////////////////

// Create VM
//
//
router.post("/users/:slug/vms", async (ctx: Context) => {
  ctx.assertAuthorized(ctx.currUser, "CREATE_VM");

  // Load user
  const user = await db.findUserBySlug(ctx.params.slug).then(pre.presentUser);
  ctx.assert(user, 404);

  // Validation
  ctx
    .validateBody("markup")
    .isString("Message is required")
    .isLength(
      1,
      config.MAX_VM_LENGTH,
      "Message must be 1-" + config.MAX_VM_LENGTH + " chars",
    );

  if (ctx.request.body.parent_vm_id) {
    ctx.validateBody("parent_vm_id").toInt();
  }

  const html = bbcode(ctx.vals.markup);

  // Create VM
  const vm = await db.createVm({
    from_user_id: ctx.currUser.id,
    to_user_id: user.id,
    markup: ctx.vals.markup,
    html,
    parent_vm_id: ctx.vals.parent_vm_id,
  });

  // if VM is a reply, notify everyone in the thread and the owner of the
  // profile. but don't notify currUser.
  if (vm.parent_vm_id) {
    let userIds = await db.getVmThreadUserIds(vm.parent_vm_id || vm.id);
    // push on the profile owner
    userIds.push(vm.to_user_id);
    // don't notify anyone twice
    userIds = _.uniq(userIds);
    // don't notify self
    userIds = userIds.filter((id) => id !== ctx.currUser.id);
    // send out notifications in parallel
    await Promise.all(
      userIds.map((toUserId) => {
        return db.createVmNotification({
          type: "REPLY_VM",
          from_user_id: vm.from_user_id,
          to_user_id: toUserId,
          vm_id: vm.parent_vm_id || vm.id,
        });
      }),
    );
  } else {
    // else, it's a top-level VM. just notify profile owner
    // unless we are leaving VM on our own wall
    if (vm.from_user_id !== vm.to_user_id) {
      await db.createVmNotification({
        type: "TOPLEVEL_VM",
        from_user_id: vm.from_user_id,
        to_user_id: vm.to_user_id,
        vm_id: vm.parent_vm_id || vm.id,
      });
    }
  }

  ctx.flash = {
    message: ["success", "Visitor message successfully posted"],
  };
  ctx.redirect(user.url + "/vms#vm-" + vm.id);
});

//
// Show user recent topics
//
router.get("/users/:slug/recent-topics", async (ctx: Context) => {
  // Load user
  var user;
  if (
    ctx.currUser &&
    (cancan.isStaffRole(ctx.currUser.role) ||
      ctx.currUser.slug === ctx.params.slug)
  )
    user = await db.findUserWithRatingsBySlug(ctx.params.slug);
  else user = await db.findUserBySlug(ctx.params.slug);
  ctx.assert(user, 404);
  user = pre.presentUser(user);

  // will be undefined or number
  if (ctx.query["before-id"]) ctx.validateQuery("before-id").toInt();

  // Load recent topics
  var topics = (
    await db.findRecentTopicsForUserId(user.id, ctx.vals["before-id"])
  )
    .filter((topic) => cancan.can(ctx.currUser, "READ_TOPIC", topic))
    .map(pre.presentTopic);

  var nextBeforeId = topics.length > 0 ? _.last(topics).id : null;

  ctx.set("Link", util.format('<%s>; rel="canonical"', config.HOST + user.url));

  await ctx.render("show_user_recent_topics", {
    ctx,
    user,
    topics,
    title: user.uname,
    // Pagination
    nextBeforeId,
    topicsPerPage: 5,
  });
});

//
// Delete user
//
// router.delete('/users/:id', async (ctx: Context) => {
//     var user = await db.findUser(ctx.params.id)
//     ctx.assert(user, 404)
//     ctx.assertAuthorized(ctx.currUser, 'DELETE_USER', user)
//     await db.deleteUser(ctx.params.id)

//     ctx.flash = {
//         message: [
//             'success',
//             util.format(
//                 'User deleted along with %d posts and %d PMs',
//                 user.posts_count,
//                 user.pms_count
//             ),
//         ],
//     }
//     ctx.response.redirect('/')
// })

// Params
// - submit: 'save' | 'delete'
// - files
//   - avatar
//     - path
//
// @koa2
// TODO: Put the multipart middleware only on specific routes like this one
router.post("/users/:slug/avatar", async (ctx: Context) => {
  // Ensure user exists
  const user = await db.findUserBySlug(ctx.params.slug).then(pre.presentUser);
  ctx.assert(user, 404);
  // Ensure currUser is authorized to update user
  ctx.assertAuthorized(ctx.currUser, "UPDATE_USER", user);

  // Handle avatar delete button
  if (ctx.request.body.submit === "delete") {
    await db.deleteAvatar(user.id);
    ctx.flash = { message: ["success", "Avatar deleted"] };
    ctx.response.redirect(user.url + "/edit#avatar");
    return;
  }

  // Ensure params
  // FIXME: Sloppy/lame validation
  ctx.assert(ctx.request.files, 400, "Must choose an avatar to upload");
  ctx.assert(ctx.request.files.avatar, 400, "Must choose an avatar to upload");

  ctx.assert(
    !Array.isArray(ctx.request.files.avatar),
    400,
    "avatar must be a single file",
  );

  ctx.assert(
    ctx.request.files.avatar.size > 0,
    400,
    "Must choose an avatar to upload",
  );

  // TODO: Pretty sure the handleAvatarTransformAndUpload fn does a magic bytes check?
  // But we can pre-verify for better a error message
  ctx.assert(
    (ctx.request.files.avatar.mimetype ?? "").startsWith("image/"),
    400,
    "Must be an image",
  );

  // Process avatar, upload to S3, and get the S3 url
  var avatarUrl = await avatar.handleAvatarTransformAndUpload(
    // @ts-ignore
    ctx.request.files.avatar.filepath,
  );

  // Save new avatar url to db
  await db.updateUser(user.id, { avatar_url: avatarUrl });

  // Delete legacy avatar if it exists
  await db.deleteLegacyAvatar(user.id);

  ctx.flash = { message: ["success", "Avatar uploaded and saved"] };
  ctx.response.redirect(user.url + "/edit#avatar");
});

////////////////////////////////////////////////////////////

// Body:
// - gender: '' | 'MALE' | 'FEMALE'
//
// @koa2
router.post(
  "/users/:slug/gender",
  loadUserFromSlug("slug"),
  async (ctx: Context) => {
    ctx.assertAuthorized(ctx.currUser, "UPDATE_USER", ctx.state.user);
    ctx
      .validateBody("gender")
      .tap((x) => (["MALE", "FEMALE"].indexOf(x) > -1 ? x : null));
    await db.users.updateUser(ctx.state.user.id, { gender: ctx.vals.gender });
    ctx.flash = { message: ["success", "Gender updated"] };
    ctx.redirect(ctx.state.user.url + "/edit");
  },
);

////////////////////////////////////////////////////////////
// NUKING
////////////////////////////////////////////////////////////

// if ?override=true, don't do thw twoWeek check
router.post("/users/:slug/nuke", async (ctx: Context) => {
  var user = await db.findUserBySlug(ctx.params.slug);
  ctx.assert(user, 404);
  pre.presentUser(user);
  ctx.assertAuthorized(ctx.currUser, "NUKE_USER", user);
  // prevent accidental nukings. if a user is over 2 weeks old,
  // they aren't likely to be a spambot.
  if (ctx.query.override !== "true") {
    var twoWeeks = 1000 * 60 * 60 * 24 * 7 * 2;
    if (Date.now() - user.created_at.getTime() > twoWeeks) {
      ctx.body =
        "[Accidental Nuke Prevention] User is too old to be nuked. If this really is a spambot, let Mahz know in the mod forum.";
      return;
    }
  }

  try {
    await db.nukeUser({ spambot: user.id, nuker: ctx.currUser.id });
  } catch (err) {
    if (err === "ALREADY_NUKED") {
      ctx.flash = { message: ["success", "Nuked the bastard"] };
      ctx.redirect(user.url);
      return;
    }
    throw err;
  }

  // Unapprove in background
  db.users
    .unapproveUser(user.id)
    .catch((err) =>
      console.error(`error when unapproving user ${user.id}`, err),
    );

  // Broadcast to Discord in the background
  broadcastManualNuke({ nuker: ctx.currUser, spambot: user }).catch((err) =>
    console.error("broadcastManualNuke error", err),
  );

  ctx.flash = { message: ["success", "Nuked the bastard"] };
  ctx.redirect(user.url);
});

////////////////////////////////////////////////////////////

router.post("/users/:slug/unnuke", async (ctx: Context) => {
  ctx.assert(ctx.currUser, 404);
  const user = await db.findUserBySlug(ctx.params.slug).then(pre.presentUser);
  ctx.assert(user, 404);
  ctx.assertAuthorized(ctx.currUser, "NUKE_USER", user);

  await db.unnukeUser(user.id);

  // Approve in background
  db.users
    .approveUser({ approvedBy: ctx.currUser.id, targetUser: user.id })
    .catch((err) => console.error(`error when approving user ${user.id}`, err));

  // Broadcast to Discord in the background
  broadcastManualUnnuke({ nuker: ctx.currUser, spambot: user }).catch((err) =>
    console.error("broadcastManualUnnuke error", err),
  );

  ctx.flash = { message: ["success", "Un-nuked the user"] };
  ctx.redirect(user.url);
});

////////////////////////////////////////////////////////////

export default router;
