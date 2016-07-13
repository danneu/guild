'use strict';
// 3rd
const Router = require('koa-router');
// 1st
const cancan = require('../cancan');
const db = require('../db');

////////////////////////////////////////////////////////////

const router = new Router();

////////////////////////////////////////////////////////////

router.get('/chatlogs', function*() {
  this.assertAuthorized(this.currUser, 'READ_CHATLOGS');
  const logs = yield db.chat.getChatLogDays();
  yield this.render('list_chatlogs', {
    ctx: this,
    logs: logs
  });
});

////////////////////////////////////////////////////////////

// :when is 'YYYY-MM-DD'
router.get('/chatlogs/:when', function * () {
  // Temporarily disable
  this.assertAuthorized(this.currUser, 'READ_CHATLOGS');
  // TODO: Validate
  this.validateParam('when')
    .match(/\d{4}-\d{2}-\d{2}/, 'Invalid date format');

  const log = yield db.chat.findLogByDateTrunc(this.vals.when);
  this.assert(log, 404);
  this.assert(log.length > 0, 404);

  yield this.render('show_chatlog', {
    ctx: this,
    log: log,
    when: log[0].when
  });
});

////////////////////////////////////////////////////////////

module.exports = router;
