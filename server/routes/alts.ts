import Router from "@koa/router";
import * as db from "../db";
import * as belt from "../belt";
import { pool } from "../db/util";

const router = new Router();

//
// Remove an account from the alt system
//
router.post('/me/unlink', async ctx => {
  ctx.assert(ctx.currUser, 404);
  ctx.validateBody('uname').required('Invalid creds (1)');
  var newUser = ctx.currUser.uname === ctx.vals.uname ?
    ctx.currUser :                                                             //If we're unlinking ourselves, no need to check alts
    ctx.currUser.alts.filter(alt => {return alt.uname  === ctx.vals.uname})[0]; //Filter should only return zero or one item (we set it to that item or undefined)
  ctx.assert(newUser, 403);  //See if we're unlinking ourselves or any of the current user's alts contain the new account

  // User is confirmed to be an alt. Now unlink it
  await db.users.unlinkUserAlts(newUser.id);
  ctx.flash = { message: ['success', 'Account unlinked successfully'] };
  ctx.response.redirect('/');
});

//
// If the login succeeds, link their accounts in the db
//
router.post('/me/link', async ctx => {
  ctx.assert(ctx.currUser, 404);
  ctx.validateBody('uname-or-email').required('Invalid creds (1)');
  ctx.validateBody('password').required('Invalid creds (2)');
  var user = await db.findUserByUnameOrEmail(ctx.vals['uname-or-email']);
  ctx.check(user, 'Invalid creds (3)');
  ctx.check(
    await belt.checkPassword(ctx.vals.password, user.digest),
    'Invalid creds (4)'
  );

  // User authenticated. Now connect accounts in the db
  await db.users.linkUserAlts(ctx.currUser.id, user.id);
  ctx.flash = { message: ['success', 'Account linked successfully'] };
  ctx.response.redirect('/');
});

//
// Swap to one of our alts
//
router.post('/swapAccount', async ctx => {
  ctx.assert(ctx.currUser && ctx.currUser.alts, 404);
  ctx.validateBody('uname').required('Invalid creds (1)');
  var newUser = ctx.currUser.alts.filter(alt => {return alt.uname  === ctx.vals.uname})[0]; //Filter should only return zero or one item (we set it to that item or undefined)
  ctx.assert(newUser, 403);  //See if any of the current user's alts contain the new account
  await db.logoutSession(ctx.currUser.id, ctx.cookies.get('sessionId'));  //End the current session to avoid polluting db
  var session = await db.createSession(pool, {
    userId: newUser.id,
    ipAddress: ctx.request.ip,
    interval:  '1 year',  //If they're using the switcher, they probably want a long-lived session.
  });

  ctx.cookies.set('sessionId', session.id, {
    expires: belt.futureDate({ years: 1 }),
  });
  ctx.status = 200; //Return OK
});

export default router;
