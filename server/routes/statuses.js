"use strict";
// 3rd party
var Router = require('koa-router');
var debug = require('debug')('app:routes:statuses');
// 1st party
var db = require('../db');
var belt = require('../belt');
var pre = require('../presenters');

////////////////////////////////////////////////////////////

var router = new Router();

//
// MIDDLEWARE
//

// expects :status_id url param
function loadStatus () {
  return function * (next) {
    this.state.status = yield db.findStatusById(this.params.status_id);
    this.assert(this.state.status, 404);
    pre.presentStatus(this.state.status);
    yield * next;
  };
}

////////////////////////////////////////////////////////////

// Create status
//
// Required params
// - text: String
router.post('/me/statuses', function * () {
  // Ensure user is authorized
  this.assertAuthorized(this.currUser, 'CREATE_USER_STATUS', this.currUser);
  // Validate params
  this.validateBody('text')
    .notEmpty('text is required')
    .trim()
    .isLength(1, 200, 'text must be 1-200 chars');
  const html = belt.autolink(belt.escapeHtml(this.vals.text));
  yield db.createStatus({
    user_id: this.currUser.id,
    text: this.vals.text,
    html
  });
  this.flash = { message: ['success', 'Status updated'] };
  this.redirect(`/users/${this.currUser.slug}#status`);
});

////////////////////////////////////////////////////////////

// Show all statuses
router.get('/statuses', function * () {
  return this.body = 'Status list currently disabled while I try to fix a performance issue with it.';
  const statuses = yield db.findAllStatuses();
  statuses.forEach(pre.presentStatus);
  yield this.render('list_statuses', {
    ctx: this,
    statuses
  });
});

////////////////////////////////////////////////////////////

// This is browser endpoint
// TODO: remove /browser/ scope once i add /api/ scope to other endpoint
// Sync with POST /api/statuses/:status_id/like
router.post('/browser/statuses/:status_id/like', loadStatus(), function * () {
  const status = this.state.status;
  // Authorize user
  this.assertAuthorized(this.currUser, 'LIKE_STATUS', status);
  // Ensure it's been 3 seconds since user's last like
  const latestLikeAt = yield db.latestStatusLikeAt(this.currUser.id);
  if (latestLikeAt && belt.isNewerThan(latestLikeAt, { seconds: 3 })) {
    this.check(false, 'Can only like a status once every 3 seconds. Don\'t wear \'em out!');
    return;
  }
  // Create like
  yield db.likeStatus({
    status_id: status.id,
    user_id: this.currUser.id
  });
  // Redirect
  this.flash = {
    message: ['success', 'Success. Imagine how much that\'s gonna brighten their day!']
  };
  this.redirect('/statuses');
});

// This is AJAX endpoint
// TODO: scope to /api/statuses/...
// Sync with POST /browser/statuses/:status_id/like
router.post('/statuses/:status_id/like', loadStatus(), function * () {
  const status = this.state.status;
  // Authorize user
  this.assertAuthorized(this.currUser, 'LIKE_STATUS', status);
  // Ensure it's been 3 seconds since user's last like
  const latestLikeAt = yield db.latestStatusLikeAt(this.currUser.id);
  if (latestLikeAt && belt.isNewerThan(latestLikeAt, { seconds: 3 })) {
    this.status = 400;
    this.body = JSON.stringify({ error: 'TOO_SOON' });
    return;
  }
  yield db.likeStatus({
    status_id: status.id,
    user_id: this.currUser.id
  });
  this.status = 200;
});

////////////////////////////////////////////////////////////

router.del('/statuses/:status_id', loadStatus(), function * () {
  const status = this.state.status;
  // Ensure user is authorized to delete it
  this.assertAuthorized(this.currUser, 'DELETE_USER_STATUS', status);
  // Delete it
  yield db.deleteStatusById(status.id);
  // Redirect back to profile
  this.flash = { message: ['success', 'Status deleted'] };
  this.redirect(`${status.user.url}#status`);
});

////////////////////////////////////////////////////////////

router.del('/me/current-status', function * () {
  // Ensure user is logged in
  this.assert(this.currUser, 403, 'You must log in to do that');
  yield db.clearCurrentStatusForUserId(this.currUser.id);
  this.flash = { message: ['success', 'Current status cleared'] };
  this.redirect('/users/' + this.currUser.slug);
});

////////////////////////////////////////////////////////////

module.exports = router;
