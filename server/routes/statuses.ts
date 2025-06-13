// 3rd party
import Router from "@koa/router";
// import createDebug from 'debug'
// const debug = createDebug('app:routes:statuses')
// 1st party
import * as db from "../db/index.js";
import * as belt from "../belt.js";
import * as pre from "../presenters.js";
import { Context, Next } from "koa";

////////////////////////////////////////////////////////////

const router = new Router();

//
// MIDDLEWARE
//

// expects :status_id url param
function loadStatus(key = "status_id") {
  return async (ctx: Context, next: Next) => {
    ctx.state.status = await db.findStatusById(ctx.params[key]);
    ctx.assert(ctx.state.status, 404);
    pre.presentStatus(ctx.state.status);
    return next();
  };
}

////////////////////////////////////////////////////////////

// Create status
//
// Required params
// - text: String
router.post("/me/statuses", async (ctx: Context) => {
  // Ensure user is authorized
  ctx.assertAuthorized(ctx.currUser, "CREATE_USER_STATUS", ctx.currUser);
  // Validate params
  ctx
    .validateBody("text")
    .isString("text is required")
    .trim()
    .isLength(1, 200, "text must be 1-200 chars");
  const html = belt.autolink(belt.escapeHtml(ctx.vals.text));
  await db.createStatus({
    user_id: ctx.currUser.id,
    text: ctx.vals.text,
    html,
  });
  ctx.flash = { message: ["success", "Status updated"] };
  ctx.redirect(`/users/${ctx.currUser.slug}#status`);
});

////////////////////////////////////////////////////////////

// Show all statuses
router.get("/statuses", async (ctx: Context) => {
  const statuses = await db.findAllStatuses();
  statuses.forEach(pre.presentStatus);
  await ctx.render("list_statuses", {
    ctx,
    statuses,
  });
});

////////////////////////////////////////////////////////////

// This is browser endpoint
// TODO: remove /browser/ scope once i add /api/ scope to other endpoint
// Sync with POST /api/statuses/:status_id/like
router.post(
  "/browser/statuses/:status_id/like",
  loadStatus(),
  async (ctx: Context) => {
    const status = ctx.state.status;
    // Authorize user
    ctx.assertAuthorized(ctx.currUser, "LIKE_STATUS", status);
    // Ensure it's been 3 seconds since user's last like
    const latestLikeAt = await db.latestStatusLikeAt(ctx.currUser.id);
    if (latestLikeAt && belt.isNewerThan(latestLikeAt, { seconds: 3 })) {
      ctx.check(
        false,
        "Can only like a status once every 3 seconds. Don't wear 'em out!",
      );
      return;
    }
    // Create like
    await db.likeStatus({
      status_id: status.id,
      user_id: ctx.currUser.id,
    });
    // Redirect
    ctx.flash = {
      message: [
        "success",
        "Success. Imagine how much that's gonna brighten their day!",
      ],
    };
    ctx.redirect("/statuses");
  },
);

// This is AJAX endpoint
// TODO: scope to /api/statuses/...
// Sync with POST /browser/statuses/:status_id/like
router.post("/statuses/:status_id/like", loadStatus(), async (ctx: Context) => {
  const status = ctx.state.status;
  // Authorize user
  ctx.assertAuthorized(ctx.currUser, "LIKE_STATUS", status);
  // Ensure it's been 3 seconds since user's last like
  const latestLikeAt = await db.latestStatusLikeAt(ctx.currUser.id);
  if (latestLikeAt && belt.isNewerThan(latestLikeAt, { seconds: 3 })) {
    ctx.status = 400;
    ctx.body = JSON.stringify({ error: "TOO_SOON" });
    return;
  }
  await db.likeStatus({
    status_id: status.id,
    user_id: ctx.currUser.id,
  });
  ctx.status = 200;
});

////////////////////////////////////////////////////////////

router.del("/statuses/:status_id", loadStatus(), async (ctx: Context) => {
  const status = ctx.state.status;
  // Ensure user is authorized to delete it
  ctx.assertAuthorized(ctx.currUser, "DELETE_USER_STATUS", status);
  // Delete it
  await db.deleteStatusById(status.id);
  // Redirect back to profile
  ctx.flash = { message: ["success", "Status deleted"] };
  ctx.redirect(`${status.user.url}#status`);
});

////////////////////////////////////////////////////////////

router.del("/me/current-status", async (ctx: Context) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403, "You must log in to do that");
  await db.clearCurrentStatusForUserId(ctx.currUser.id);
  ctx.flash = { message: ["success", "Current status cleared"] };
  ctx.redirect("/users/" + ctx.currUser.slug);
});

////////////////////////////////////////////////////////////

export default router;
