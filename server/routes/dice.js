'use strict';
// 3rd
const assert = require('better-assert');
const router = require('koa-router')();
const debug = require('debug')('app:routes:dice');
// 1st
const db = require('../db');
const pre = require('../presenters');

// HELPERS

function * loadCampaign (next) {
  const campaign = yield db.dice.getCampaign(this.params.campaign_id);
  this.assert(campaign, 404);
  pre.presentCampaign(campaign);
  this.state.campaign = campaign;
  yield * next;
}

function * loadRoll (next) {
  const roll = yield db.dice.getRoll(this.params.roll_id);
  this.assert(roll, 404);
  pre.presentRoll(roll);
  this.state.roll = roll;
  yield * next;
}

////////////////////////////////////////////////////////////

// List all dice campaigns/rolls
//
router.get('/campaigns', function * () {
  const campaigns = yield db.dice.listCampaignsByActivity();
  campaigns.forEach(pre.presentCampaign);
  // RESPOND
  yield this.render('dice/list_campaigns', {
    ctx: this,
    campaigns,
    title: 'All Campaigns'
  });
});

// Create campaign
//
router.post('/campaigns', function * () {
  this.assertAuthorized(this.currUser, 'CREATE_CAMPAIGN');
  // VALIDATE
  this.validateBody('title').isString().trim().isLength(1, 300);
  this.validateBody('markup').isString().trim().isLength(0, 10000);
  // INSERT
  const campaign = yield db.dice.insertCampaign(this.currUser.id, this.vals.title, this.vals.markup);
  // RESPOND
  pre.presentCampaign(campaign);
  this.flash = { message: ['success', 'Dice campaign created'] };
  this.redirect(campaign.url);
});

// Show campaign
//
router.get('/campaigns/:campaign_id', loadCampaign, function * () {
  this.assertAuthorized(this.currUser, 'READ_CAMPAIGN', this.state.campaign);
  // LOAD
  const rolls = yield db.dice.getCampaignRolls(this.state.campaign.id);
  rolls.forEach(pre.presentRoll);
  // RESPOND
  yield this.render('dice/show_campaign', {
    ctx: this,
    campaign: this.state.campaign,
    rolls,
    title: `Dice: ${this.state.campaign.title} by ${this.state.campaign.user.uname}`
  });
});

// Create roll
//
router.post('/campaigns/:campaign_id/rolls', loadCampaign, function * () {
  // AUTHZ
  this.assertAuthorized(this.currUser, 'CREATE_ROLL', this.state.campaign);
  // VALIDATE
  this.validateBody('syntax').isString().isLength(1, 300);
  this.validateBody('note').isString().isLength(0, 300);
  // INSERT
  try {
    yield db.dice.insertRoll(this.currUser.id, this.state.campaign.id, this.vals.syntax, this.vals.note);
  } catch (err) {
    console.log('err:', err)
    if (typeof err === 'string') {
      this.check(false, 'Dice error: ' + err);
    } else {
      throw err;
    }
  }
  // RESPOND
  this.flash = { message: ['success', 'Roll created'] };
  this.redirect(this.state.campaign.url);
});

// Show roll
//
router.get('/rolls/:roll_id', loadRoll, function * () {
  yield this.render('dice/show_roll', {
    ctx: this,
    campaign: this.state.roll.campaign,
    roll: this.state.roll
  });
});

// Update campaign
//
router.put('/campaigns/:campaign_id', loadCampaign, function * () {
  // AUTHZ
  this.assertAuthorized(this.currUser, 'UPDATE_CAMPAIGN', this.state.campaign);
  // VALIDATE
  this.validateBody('title').isString().trim().isLength(1, 300);
  this.validateBody('markup').isString().trim().isLength(0, 10000);
  // SAVE
  yield db.dice.updateCampaign(this.state.campaign.id, this.vals.title, this.vals.markup);
  // RESPOND
  this.flash = { message: ['success', 'Campaign updated'] };
  this.redirect(this.state.campaign.url);
});

////////////////////////////////////////////////////////////

module.exports = router;
