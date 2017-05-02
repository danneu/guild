'use strict';
// 3rd
const debug = require('debug')('app:db:dice');
const assert = require('better-assert');
// 1st
const bbcode = require('../bbcode');
const dice = require('../dice');
const {pool} = require('./util')
const {sql} = require('pg-extra')

exports.getCampaign = async function (campaignId) {
  return pool.one(sql`
    SELECT
      c.*,
      to_json(u.*) "user"
    FROM campaigns c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = ${campaignId}
  `)
}

exports.listCampaignsByActivity = async function () {
  return pool.many(sql`
    SELECT
      c.*,
      to_json(users.*) "user",
      to_json(r.*) "last_roll"
    FROM campaigns c
    JOIN users ON c.user_id = users.id
    LEFT OUTER JOIN rolls r ON c.last_roll_id = r.id
    ORDER BY c.last_roll_id DESC NULLS LAST
    LIMIT 100
  `)
}

// Ordered by newest first
exports.getCampaignsForUser = async function (userId) {
  assert(userId)
  return pool.many(sql`
    SELECT
      c.*,
      to_json(users.*) "user",
      to_json(r.*) "last_roll"
    FROM campaigns c
    JOIN users ON c.user_id = users.id
    LEFT OUTER JOIN rolls r ON c.last_roll_id = r.id
    WHERE c.user_id = ${userId}
    ORDER BY c.id DESC
    LIMIT 100
  `)
}

exports.getCampaignRolls = async function (campaignId) {
  assert(campaignId)
  return pool.many(sql`
    SELECT
      r.*,
      to_json(users.*) "user"
    FROM rolls r
    JOIN users ON r.user_id = users.id
    WHERE r.campaign_id = ${campaignId}
    ORDER BY r.id DESC
    LIMIT 100
  `)
}

// markup is optional
exports.updateCampaign = async function (campaignId, title, markup) {
  assert(Number.isInteger(campaignId))
  assert(typeof title === 'string')
  let html
  if (typeof markup === 'string') {
    html = bbcode(markup)
  }
  return pool.one(sql`
    UPDATE campaigns
    SET title = ${title}
      , markup = ${markup}
      , html = ${html}
    WHERE id = ${campaignId}
  `)
}

// markup is optional
exports.insertCampaign = async function (userId, title, markup) {
  assert(Number.isInteger(userId))
  assert(typeof title === 'string')
  let html
  if (typeof markup === 'string') {
    html = bbcode(markup)
  }
  return pool.one(sql`
    INSERT INTO campaigns (user_id, title, markup, html)
    VALUES (${userId}, ${title}, ${markup}, ${html})
    RETURNING *
  `)
}

// note is optional
exports.insertRoll = async function (userId, campaignId, syntax, note) {
  assert(Number.isInteger(userId))
  assert(Number.isInteger(campaignId))
  assert(typeof syntax === 'string')
  // throws if syntax is invalid. err.message for parser error message.
  const output = dice.roll(syntax)
  return pool.withTransaction(async (client) => {
    const roll = await client.one(sql`
      INSERT INTO rolls (user_id, campaign_id, syntax, rolls, total, note)
      VALUES (${userId}, ${campaignId}, ${syntax},
        ${JSON.stringify(output.rolls)}, ${output.total}, ${note})
      RETURNING *
    `)

    await client.query(sql`
      UPDATE campaigns
      SET last_roll_at = NOW()
        , roll_count = roll_count + 1
        , last_roll_id = ${roll.id}
      WHERE id = ${campaignId}
    `)

    return roll
  })
}

exports.getRoll = async function (rollId) {
  assert(rollId)
  return pool.one(sql`
    SELECT
      r.*,
      to_json(u.*) "user",
      to_json(c.*) "campaign"
    FROM rolls r
    JOIN users u ON r.user_id = u.id
    JOIN campaigns c ON r.campaign_id = c.id
    WHERE r.id = ${rollId}
  `)
}
