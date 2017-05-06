"use strict";
// 3rd party
var Router = require('koa-router');
var _ = require('lodash');
var debug = require('debug')('app:routes:convos');
var bouncer = require('koa-bouncer');
// 1st party
var db = require('../db');
var belt = require('../belt');
var pre = require('../presenters');
var config = require('../config');
var welcomePm = require('../welcome_pm');
var cancan = require('../cancan');
var avatar = require('../avatar');
var bbcode = require('../bbcode');
var paginate = require('../paginate');

var router = new Router();

////////////////////////////////////////////////////////////

//
// Create convo
// Params:
// - 'to': Comma-delimited string of unames user wants to send to
// - 'title'
// - 'markup'
//
router.post('/convos', async (ctx) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = 'PM system currently disabled';
    return;
  }

  ctx.assertAuthorized(ctx.currUser, 'CREATE_CONVO');

  // Light input validation
  ctx.validateBody('title')
     .isLength(1, config.MAX_TOPIC_TITLE_LENGTH,
               `Title must be 1-${config.MAX_TOPIC_TITLE_LENGTH} chars`)
  ctx.validateBody('markup')
    .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH,
              'Post text must be ' + config.MIN_POST_LENGTH +
              '-' + config.MAX_POST_LENGTH + ' chars long');
  // Array of lowercase uname strings
  // Remove empty (Note: unames contains lowercase unames)
  ctx.validateBody('to')
    .tap((v) => {
      return v.split(',').map((uname) => {
        return uname.trim().toLowerCase()
      }).filter(Boolean)
    })
    // Ensure user didn't specify themself
    .tap((unames) => {
      return unames.filter((uname) => {
        return uname !== ctx.currUser.uname.toLowerCase();
      })
    })
    // Remove duplicates
    .uniq()
    .isLength(0, 5, 'You cannot send a PM to more than 5 people at once');

  // TODO: Validation, Error msgs, preserve params

  var unames = ctx.vals.to;
  var title = ctx.vals.title;
  var markup = ctx.vals.markup;

  debug('==============');
  debug(ctx.vals);

  // Ensure they are all real users
  var users = await db.findUsersByUnames(unames);

  // If not all unames resolved into users, then we return user to form
  // to fix it.
  if (users.length !== unames.length) {
    var rejectedUnames = _.difference(unames, users.map(function(user) {
      return user.uname.toLowerCase();
    }));
    ctx.flash = {
      message: [
        'danger',
        'No users were found with these names: ' + rejectedUnames.join(', ')
      ]
    };
    ctx.response.redirect('/convos/new?to=' + unames.join(','));
    return;
  }

  // Render bbcode
  var html = bbcode(markup);

  // If all unames are valid, then we can create a convo
  const toUserIds = users.map((x) => x.id)
  const convo = await db.createConvo({
    userId: ctx.currUser.id,
    toUserIds,
    title,
    markup,
    html,
    ipAddress: ctx.request.ip
  }).then(pre.presentConvo);

  // Create CONVO notification for each recipient
  toUserIds.map(function (toUserId) {
    return db.createConvoNotification({
      from_user_id: ctx.currUser.id,
      to_user_id: toUserId,
      convo_id: convo.id
    });
  });

  ctx.response.redirect(convo.url);
});

////////////////////////////////////////////////////////////

//
// New Convo
//
// TODO: Implement typeahead
router.get('/convos/new', async (ctx) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = 'PM system currently disabled';
    return;
  }

  ctx.assertAuthorized(ctx.currUser, 'CREATE_CONVO');
  // TODO: Validation, Error msgs, preserve params
  await ctx.render('new_convo', {
    ctx,
    to: ctx.request.query.to,
    title: 'New Conversation'
  });
});

////////////////////////////////////////////////////////////

//
// Create PM
// Body params
// - markup
//
router.post('/convos/:convoId/pms', async (ctx) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = 'PM system currently disabled';
    return;
  }

  ctx.assert(ctx.currUser, 403);

  try {
    ctx.validateBody('markup')
      .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);
  } catch(ex) {
    if (ex instanceof bouncer.ValidationError) {
      ctx.flash = {
        message: ['danger', ex.message],
        params: ctx.request.body
      };
      ctx.redirect('/convos/' + ctx.params.convoId);
    }
    throw ex;
  }

  const convo = await db.convos.getConvo(ctx.params.convoId);
  ctx.assert(convo, 404);
  ctx.assertAuthorized(ctx.currUser, 'CREATE_PM', convo);

  // Render bbcode
  var html = bbcode(ctx.vals.markup);

  var pm = await db.createPm({
    userId: ctx.currUser.id,
    ipAddress: ctx.request.ip,
    convoId: ctx.params.convoId,
    markup: ctx.vals.markup,
    html: html
  });
  pre.presentPm(pm);

  // Get only userIds of the *other* participants
  // Don't want to create notification for ourself
  var toUserIds = (await db.convos.findParticipantIds(ctx.params.convoId))
    .filter((userId) => userId !== ctx.currUser.id)

  // Upsert notifications table
  // TODO: config.MAX_CONVO_PARTICIPANTS instead of hard-coded 5
  toUserIds.map(function (toUserId) {
    return db.createPmNotification({
      from_user_id: ctx.currUser.id,
      to_user_id: toUserId,
      convo_id: ctx.params.convoId
    });
  });

  ctx.redirect(pm.url);
});

////////////////////////////////////////////////////////////

// Empty trash folder
router.delete('/me/convos/trash', async (ctx) => {
  ctx.assert(ctx.currUser, 404)

  await db.convos.deleteTrash(ctx.currUser.id)

  ctx.flash = { message: ['success', 'Trash deleted'] }
  ctx.redirect('/me/convos')
})

//
// Delete convo
//
// Body: { ids: [Int] }
router.delete('/me/convos', async (ctx) => {
  const ids = ctx.validateBody('ids')
    .toArray()
    .toInts()
    .val()

  const convos = await db.convos.getConvos(ids)
    .then((xs) => xs.map(pre.presentConvo))

  ctx.assert(
    convos.every((convo) => cancan.can(ctx.currUser, 'DELETE_CONVO', convo)),
    401,
    'You do not have access to all of the selected convos'
  )

  await db.convos.deleteConvos(ctx.currUser.id, convos.map((c) => c.id))

  ctx.flash = { message: ['success', 'Convos deleted'] }
  ctx.redirect('/me/convos')
})

//
// Delete convo
//
router.delete('/convos/:convoId', async (ctx) => {
  const {convoId} = ctx.params
  const convo = await db.convos.getConvo(convoId)
    .then(pre.presentConvo)
  ctx.assert(convo, 404)
  ctx.assertAuthorized(ctx.currUser, 'DELETE_CONVO', convo)

  await db.convos.deleteConvos(ctx.currUser.id, [convo.id])

  ctx.flash = { message: ['success', 'Convo deleted'] }
  ctx.redirect('/me/convos')
})

////////////////////////////////////////////////////////////

//
// Show convo
//
router.get('/convos/:convoId', async (ctx) => {
  var convoId = ctx.params.convoId;

  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = 'PM system currently disabled';
    return;
  }

  ctx.assert(ctx.currUser, 404);
  var convo = await db.convos.getConvo(convoId)
  ctx.assert(convo, 404);
  ctx.assertAuthorized(ctx.currUser, 'READ_CONVO', convo);

  const folder = (() => {
    return convo.cp.filter(cp => cp.user_id === ctx.currUser.id)[0].folder;
  })();

  ctx.validateQuery('page')
    .defaultTo(1)
    .toInt()
    // Clamp it to minimum of 1
    .tap((n) => Math.max(1, n))

  // If ?page=1 was given, then redirect without param
  // since page 1 is already the canonical destination of a convo url
  if (ctx.query.page && ctx.vals.page === 1) {
    ctx.status = 301;
    return ctx.redirect(ctx.path);
  }

  var page = ctx.vals.page;
  var totalItems = convo.pms_count;
  var totalPages = belt.calcTotalPostPages(totalItems);

  // Redirect to the highest page if page parameter exceeded it
  if (page > totalPages) {
    var redirectUrl = page === 1 ? ctx.path : ctx.path + '?page=' + totalPages;
    return ctx.redirect(redirectUrl);
  }

  // 0 or 1
  var count = await db.deleteConvoNotification(ctx.currUser.id, convoId);

  // Update the stale user's counts so that the notification count is reduced
  // appropriately when the page loads. Otherwise, the counts won't be updated
  // til next request.
  ctx.currUser.notifications_count -= count;
  ctx.currUser.convo_notifications_count -= count;

  var pms = await db.findPmsByConvoId(convoId, page);
  convo.pms = pms;
  convo = pre.presentConvo(convo);
  await ctx.render('show_convo', {
    ctx,
    convo: convo,
    title: convo.title,
    // Pagination
    currPage: page,
    totalPages: totalPages,
    folder
  });
});

////////////////////////////////////////////////////////////

function showConvosHandler (folder) {
  return async function _showConvosHandler (ctx) {
    if (!config.IS_PM_SYSTEM_ONLINE) {
      ctx.body = 'PM system currently disabled'
      return
    }

    ctx.validateQuery('page')
      .defaultTo(1)
      .toInt()
      .tap(n => Math.max(1, n))

    ctx.assert(ctx.currUser, 404)

    const [convos, counts] = await Promise.all([
      db.convos.findConvosInvolvingUserId(ctx.currUser.id, folder, ctx.vals.page)
        .then((xs) => xs.map(pre.presentConvo)),
      db.convos.getConvoFolderCounts(ctx.currUser.id)
    ])

    const itemsInFolder = counts[`${folder.toLowerCase()}_count`]
    const fullPaginator = paginate.makeFullPaginator(ctx.vals.page, itemsInFolder)

    var nextBeforeId = convos.length > 0 ? _.last(convos).latest_pm_id : null
    await ctx.render('me_convos', {
      ctx,
      title: 'My Private Conversations',
      counts,
      folderEmpty: itemsInFolder === 0,
      convos,
      folder,
      // FullPagination
      fullPaginator,
      // Pagination
      beforeId: ctx.vals['before-id'],
      nextBeforeId,
      perPage: config.CONVOS_PER_PAGE
    })
  }
}

router.get('/me/convos', showConvosHandler('INBOX'));
router.get('/me/convos/star', showConvosHandler('STAR'));
router.get('/me/convos/archive', showConvosHandler('ARCHIVE'));
router.get('/me/convos/trash', showConvosHandler('TRASH'));

router.put('/convos/:convoId/folder', async (ctx) => {
  var folder = ctx.request.body.folder;
  ctx.assert(['INBOX', 'STAR', 'ARCHIVE', 'TRASH'].includes(folder), 400)

  let convo = await db.convos.getConvo(ctx.params.convoId);
  ctx.assert(convo, 404);
  ctx.assertAuthorized(ctx.currUser, 'READ_CONVO', convo);

  await db.updateConvoFolder(ctx.currUser.id, convo.id, folder);

  ctx.flash = { message: ['success', 'Convo updated'] };
  ctx.redirect(`/convos/${convo.id}`);
});

////////////////////////////////////////////////////////////

// body: { ids: [Int], folder: String }
router.post('/me/convos/move', async (ctx) => {
  const {folder} = ctx.request.body
  ctx.assert(['INBOX', 'STAR', 'ARCHIVE', 'TRASH'].includes(folder), 400)

  const ids = ctx.validateBody('ids')
    .toArray()
    .toInts()
    .val()

  const convos = await db.convos.getConvos(ids)
    .then((xs) => xs.map(pre.presentConvo))

  ctx.assert(
    convos.every((convo) => cancan.can(ctx.currUser, 'READ_CONVO', convo)),
    401,
    'You do not have access to all of the selected convos'
  )

  await db.convos.moveConvos(ctx.currUser.id, ids, folder)

  ctx.flash = { message: ['success', `Convos moved to ${folder}`] }
  if (folder === 'INBOX') {
    ctx.redirect(`/me/convos`)
  } else {
    ctx.redirect(`/me/convos/${folder.toLowerCase()}`)
  }
})

////////////////////////////////////////////////////////////

module.exports = router;
