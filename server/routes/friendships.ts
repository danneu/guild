// 3rd
import Router from "@koa/router";
// 1st
import * as db from "../db";
import { TooManyFriends } from "../db/refusals";
import * as pre from "../presenters";
import * as belt from "../belt";
import { staysOnHost } from "../request_host";
import { Context } from "koa";

const router = new Router();

////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////
// Friendships
// - to_user_id Int
// - commit: Required 'add' | 'remove'
//
// Optionally pass a redirect-to query param, a page on this host to return to.
// Any other value returns to the other user's profile instead.
router.post("/me/friendships", async (ctx: Context) => {
  // ensure user logged in
  ctx.assert(ctx.currUser, 404);

  // validate body
  ctx.validateBody("commit").isIn(["add", "remove"]);
  ctx.validateBody("to_user_id").toInt();

  const target = ctx.query["redirect-to"];
  const redirectTo = staysOnHost(target, ctx.req.headers.host)
    ? target
    : "/users/" + ctx.vals.to_user_id;

  // update db
  if (ctx.vals.commit === "add") {
    try {
      await db.createFriendship(ctx.currUser.id, ctx.vals.to_user_id);
    } catch (err) {
      if (err instanceof TooManyFriends) {
        ctx.flash = {
          message: ["danger", "Cannot have more than 100 friends"],
        };
        ctx.redirect(redirectTo);
        return;
      }
      throw err;
    }
    ctx.flash = { message: ["success", "Friendship added"] };
  } else {
    await db.deleteFriendship(ctx.currUser.id, ctx.vals.to_user_id);
    ctx.flash = { message: ["success", "Friendship removed"] };
  }

  // redirect
  ctx.redirect(redirectTo);
});

////////////////////////////////////////////////////////////

router.get("/me/friendships", async (ctx: Context) => {
  // ensure user logged in
  ctx.assert(ctx.currUser, 404);
  ctx.assert(ctx.currUser.role !== "banned", 404);

  // load friendships
  const friendships = { count: 0, ghosts: [] as any[], nonghosts: [] as any[] };

  const rows = await db
    .findFriendshipsForUserId(ctx.currUser.id)
    .then((xs) => xs.map(pre.presentFriendship));

  rows.forEach((row) => {
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

  // render
  await ctx.render("me_friendships", {
    ctx,
    friendships,
    title: "My Friendships",
  });
});

////////////////////////////////////////////////////////////

export default router;
