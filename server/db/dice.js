'use strict';
// 3rd
const debug = require('debug')('app:db:dice');
const assert = require('better-assert');
// 1st
const util = require('./util');
const bbcode = require('../bbcode');
const dice = require('../dice');

exports.getCampaign = function * (campaignId) {
  return yield util.queryOne(`
    SELECT
      c.*,
      to_json(u.*) "user"
    FROM campaigns c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = $1
  `, [campaignId]);
};

exports.listCampaignsByActivity = function * () {
  return yield util.queryMany(`
    SELECT
      c.*,
      to_json(users.*) "user",
      to_json(r.*) "last_roll"
    FROM campaigns c
    JOIN users ON c.user_id = users.id
    LEFT OUTER JOIN rolls r ON c.last_roll_id = r.id
    ORDER BY c.last_roll_id DESC
    LIMIT 100
  `);
};

// Ordered by newest first
exports.getCampaignsForUser = function * (userId) {
  assert(userId);
  return yield util.queryMany(`
    SELECT
      c.*,
      to_json(users.*) "user",
      to_json(r.*) "last_roll"
    FROM campaigns c
    JOIN users ON c.user_id = users.id
    LEFT OUTER JOIN rolls r ON c.last_roll_id = r.id
    WHERE c.user_id = $1
    ORDER BY c.id DESC
    LIMIT 100
  `, [userId]);
};

exports.getCampaignRolls = function * (campaignId) {
  assert(campaignId);
  return yield util.queryMany(`
    SELECT
      r.*,
      to_json(users.*) "user"
    FROM rolls r
    JOIN users ON r.user_id = users.id
    WHERE r.campaign_id = $1
    ORDER BY r.id DESC
    LIMIT 100
  `, [campaignId]);
};

// markup is optional
exports.updateCampaign = function * (campaignId, title, markup) {
  assert(Number.isInteger(campaignId));
  assert(typeof title === 'string');
  let html;
  if (typeof markup === 'string') {
    html = bbcode(markup);
  }
  const sql = `
UPDATE campaigns
SET title = $2
  , markup = $3
  , html = $4
WHERE id = $1
  `;
  return yield util.queryOne(sql, [campaignId, title, markup, html]);
};

// markup is optional
exports.insertCampaign = function * (userId, title, markup) {
  assert(Number.isInteger(userId));
  assert(typeof title === 'string');
  let html;
  if (typeof markup === 'string') {
    html = bbcode(markup);
  }
  const sql = `
    INSERT INTO campaigns (user_id, title, markup, html)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  return yield util.queryOne(sql, [userId, title, markup, html]);
};

// note is optional
exports.insertRoll = function * (userId, campaignId, syntax, note) {
  assert(Number.isInteger(userId));
  assert(Number.isInteger(campaignId));
  assert(typeof syntax === 'string');
  // throws if syntax is invalid. err.message for parser error message.
  const output = dice.roll(syntax);
  return yield util.withTransaction(function * (client) {
    const roll = yield client.queryOnePromise(`
      INSERT INTO rolls (user_id, campaign_id, syntax, rolls, total, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [userId, campaignId, syntax, JSON.stringify(output.rolls), output.total, note]);
    yield client.queryPromise(`
      UPDATE campaigns
      SET last_roll_at = NOW()
        , roll_count = roll_count + 1
        , last_roll_id = $2
      WHERE id = $1
    `, [campaignId, roll.id]);
    return roll;
  });
};

exports.getRoll = function * (rollId) {
  assert(rollId);
  return yield util.queryOne(`
    SELECT
      r.*,
      to_json(u.*) "user",
      to_json(c.*) "campaign"
    FROM rolls r
    JOIN users u ON r.user_id = u.id
    JOIN campaigns c ON r.campaign_id = c.id
    WHERE r.id = $1
  `, [rollId]);
};
