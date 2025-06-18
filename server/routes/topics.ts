// 3rd
import Router from "@koa/router";
// import createDebug from 'debug'
// const debug = createDebug('app:routes:topics')
// 1st
import * as db from "../db";
import * as pre from "../presenters";
import * as config from "../config";
import bbcode from "../bbcode";
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

  const topic = await db.findTopicById(params.topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);

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

export default router;
