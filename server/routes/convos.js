"use strict";
// 3rd party
var Router = require('koa-router');
var _ = require('lodash');
var coParallel = require('co-parallel');
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
router.post('/convos', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    this.body = 'PM system currently disabled';
    return;
  }

  var ctx = this;
  this.assertAuthorized(this.currUser, 'CREATE_CONVO');

  // Light input validation
  this.validateBody('title')
    .isLength(config.MIN_TOPIC_TITLE_LENGTH,
              config.MAX_TOPIC_TITLE_LENGTH,
              'Title required');
  this.validateBody('markup')
    .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH,
              'Post text must be ' + config.MIN_POST_LENGTH +
              '-' + config.MAX_POST_LENGTH + ' chars long');
  // Array of lowercase uname strings
  // Remove empty (Note: unames contains lowercase unames)
  this.validateBody('to')
    .tap(function(v) {
      return v.split(',').map(function(uname) {
        return uname.trim().toLowerCase();
      });
    })
    .compact()
    // Ensure user didn't specify themself
    .tap(function(unames) {
      return unames.filter(function(uname) {
        return uname !== ctx.currUser.uname.toLowerCase();
      });
    })
    // Remove duplicates
    .uniq()
    .isLength(0, 5, 'You cannot send a PM to more than 5 people at once');

  // TODO: Validation, Error msgs, preserve params

  var unames = this.vals.to;
  var title = this.vals.title;
  var markup = this.vals.markup;

  debug('==============');
  debug(this.vals);

  // Ensure they are all real users
  var users = yield db.findUsersByUnames(unames);

  // If not all unames resolved into users, then we return user to form
  // to fix it.
  if (users.length !== unames.length) {
    var rejectedUnames = _.difference(unames, users.map(function(user) {
      return user.uname.toLowerCase();
    }));
    this.flash = {
      message: [
        'danger',
        'No users were found with these names: ' + rejectedUnames.join(', ')
      ]
    };
    this.response.redirect('/convos/new?to=' + unames.join(','));
    return;
  }

  // Render bbcode
  var html = bbcode(markup);

  // If all unames are valid, then we can create a convo
  var toUserIds = _.pluck(users, 'id');
  var convo = yield db.createConvo({
    userId: this.currUser.id,
    toUserIds: toUserIds,
    title: title,
    markup: markup,
    html: html,
    ipAddress: this.request.ip
  });
  convo = pre.presentConvo(convo);

  // Create CONVO notification for each recipient
  yield coParallel(toUserIds.map(function*(toUserId) {
    yield db.createConvoNotification({
      from_user_id: ctx.currUser.id,
      to_user_id: toUserId,
      convo_id: convo.id
    });
  }), 5);

  this.response.redirect(convo.url);
});

////////////////////////////////////////////////////////////

//
// New Convo
//
// TODO: Implement typeahead
router.get('/convos/new', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    this.body = 'PM system currently disabled';
    return;
  }

  this.assertAuthorized(this.currUser, 'CREATE_CONVO');
  // TODO: Validation, Error msgs, preserve params
  yield this.render('new_convo', {
    ctx: this,
    to: this.request.query.to,
    title: 'New Conversation'
  });
});

////////////////////////////////////////////////////////////

//
// Create PM
// Body params
// - markup
//
router.post('/convos/:convoId/pms', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    this.body = 'PM system currently disabled';
    return;
  }

  var ctx = this;

  this.assert(this.currUser, 403);

  try {
    this.validateBody('markup')
      .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);
  } catch(ex) {
    if (ex instanceof bouncer.ValidationError) {
      this.flash = {
        message: ['danger', ex.message],
        params: this.request.body
      };
      this.redirect('/convos/' + this.params.convoId);
    }
    throw ex;
  }

  var convo = yield db.findConvo(this.params.convoId);
  this.assert(convo, 404);
  this.assertAuthorized(this.currUser, 'CREATE_PM', convo);

  // Render bbcode
  var html = bbcode(this.vals.markup);

  var pm = yield db.createPm({
    userId: this.currUser.id,
    ipAddress: this.request.ip,
    convoId: this.params.convoId,
    markup: this.vals.markup,
    html: html
  });
  pm = pre.presentPm(pm);

  // Get only userIds of the *other* participants
  // Don't want to create notification for ourself
  var toUserIds = (yield db.findParticipantIds(this.params.convoId)).filter(function(userId) {
    return userId !== ctx.currUser.id;
  });

  // Upsert notifications table
  // TODO: config.MAX_CONVO_PARTICIPANTS instead of hard-coded 5
  yield coParallel(toUserIds.map(function*(toUserId) {
    yield db.createPmNotification({
      from_user_id: ctx.currUser.id,
      to_user_id: toUserId,
      convo_id: ctx.params.convoId
    });
  }), 5);

  this.redirect(pm.url);
});

////////////////////////////////////////////////////////////

//
// Show convo
//
router.get('/convos/:convoId', function*() {
  var convoId = this.params.convoId;

  if (!config.IS_PM_SYSTEM_ONLINE) {
    this.body = 'PM system currently disabled';
    return;
  }

  this.assert(this.currUser, 404);
  var convo = yield db.findConvo(convoId);
  this.assert(convo, 404);
  this.assertAuthorized(this.currUser, 'READ_CONVO', convo);

  const folder = (() => {
    return convo.cp.filter(cp => cp.user_id === this.currUser.id)[0].folder;
  })();

  this.validateQuery('page')
    .default(1)
    .toInt()
    // Clamp it to minimum of 1
    .tap(function(n) {
      return Math.max(1, n);
    });

  // If ?page=1 was given, then redirect without param
  // since page 1 is already the canonical destination of a convo url
  if (this.query.page && this.vals.page === 1) {
    this.status = 301;
    return this.redirect(this.path);
  }

  var page = this.vals.page;
  var totalItems = convo.pms_count;
  var totalPages = belt.calcTotalPostPages(totalItems);

  // Redirect to the highest page if page parameter exceeded it
  if (page > totalPages) {
    var redirectUrl = page === 1 ? this.path : this.path + '?page=' + totalPages;
    return this.redirect(redirectUrl);
  }

  // 0 or 1
  var count = yield db.deleteConvoNotification(this.currUser.id, convoId);

  // Update the stale user's counts so that the notification count is reduced
  // appropriately when the page loads. Otherwise, the counts won't be updated
  // til next request.
  this.currUser.notifications_count -= count;
  this.currUser.convo_notifications_count -= count;

  var pms = yield db.findPmsByConvoId(convoId, page);
  convo.pms = pms;
  convo = pre.presentConvo(convo);
  yield this.render('show_convo', {
    ctx: this,
    convo: convo,
    title: convo.title,
    // Pagination
    currPage: page,
    totalPages: totalPages,
    folder
  });
});

////////////////////////////////////////////////////////////

function showConvosHandler(folder) {
  return function* _showConvosHandler() {
    if (!config.IS_PM_SYSTEM_ONLINE) {
      this.body = 'PM system currently disabled';
      return;
    }

    this.validateQuery('page')
      .defaultTo(1)
      .toInt()
      .tap(n => Math.max(1, n));

    this.assert(this.currUser, 404);

    const results = yield {
      convos: db.findConvosInvolvingUserId(
        this.currUser.id, folder, this.vals.page
      ),
      counts: db.getConvoFolderCounts(this.currUser.id)
    }
    const convos = results.convos.map(pre.presentConvo);

    const itemsInFolder = results.counts[`${folder.toLowerCase()}_count`];
    const fullPaginator = paginate.makeFullPaginator(this.vals.page, itemsInFolder);

    var nextBeforeId = convos.length > 0 ? _.last(convos).latest_pm_id : null;
    yield this.render('me_convos', {
      ctx: this,
      title: 'My Private Conversations',
      counts: results.counts,
      folderEmpty: itemsInFolder === 0,
      convos,
      folder,
      // FullPagination
      fullPaginator,
      // Pagination
      beforeId: this.vals['before-id'],
      nextBeforeId: nextBeforeId,
      perPage: config.CONVOS_PER_PAGE
    });
  }
}

router.get('/me/convos', showConvosHandler('INBOX'));
router.get('/me/convos/star', showConvosHandler('STAR'));
router.get('/me/convos/archive', showConvosHandler('ARCHIVE'));
router.get('/me/convos/trash', showConvosHandler('TRASH'));

router.put('/convos/:convoId/folder', function*() {
  var folder = this.request.body.folder;
  this.assert(_.contains(['INBOX', 'STAR', 'ARCHIVE', 'TRASH'], folder), 400)

  let convo = yield db.findConvo(this.params.convoId);
  this.assert(convo, 404);
  this.assertAuthorized(this.currUser, 'READ_CONVO', convo);

  yield db.updateConvoFolder(this.currUser.id, convo.id, folder);

  this.flash = { message: ['success', 'Convo updated'] };
  this.redirect(`/convos/${convo.id}`);
});

////////////////////////////////////////////////////////////

module.exports = router;
