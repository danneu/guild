// 3rd
import Router from "@koa/router";
// import createDebug from 'debug'
// const debug = createDebug('app:routes:admin')
// 1st
import * as db from "../db";
import * as pre from "../presenters";
import { Context } from "koa";

////////////////////////////////////////////////////////////

const router = new Router();

////////////////////////////////////////////////////////////

router.post("/admin/users/merge", async (ctx: Context) => {
  ctx.assert(ctx.currUser && ctx.currUser.role === "admin");
  ctx
    .validateBody("main-slug")
    .isString()
    .trim()
    .checkPred((slug) => slug.length >= 3, "main-slug required");
  ctx
    .validateBody("husk-slug")
    .isString()
    .trim()
    .checkPred((slug) => slug.length >= 3, "husk-slug required");
  ctx
    .validateBody("confirm")
    .isString()
    .trim()
    .checkPred((slug) => slug.length >= 3, "confirm required")
    .checkPred(
      (slug) => slug === ctx.vals["main-slug"],
      "confirm must match main slug",
    );

  const mainUser = await db
    .findUserBySlug(ctx.vals["main-slug"])
    .then((user) => pre.presentUser(user));
  const huskUser = await db
    .findUserBySlug(ctx.vals["husk-slug"])
    .then((user) => pre.presentUser(user));

  ctx
    .validateBody("main-slug")
    .check(!!mainUser, "user not found for main slug");
  ctx
    .validateBody("husk-slug")
    .check(!!huskUser, "user not found for husk slug");

  await db.admin.mergeUsers({
    mainId: mainUser!.id,
    huskId: huskUser!.id,
  });

  ctx.flash = {
    message: ["success", `${huskUser!.uname} merged into ${mainUser!.uname}`],
  };
  ctx.redirect(mainUser!.url);
});

////////////////////////////////////////////////////////////

export default router;
