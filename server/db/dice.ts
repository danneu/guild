// 3rd
// import createDebug from 'debug'; 
// const debug = createDebug('app:db:dice')
import assert from 'assert'
// 1st
import bbcode from '../bbcode'
import * as dice from '../dice'
import { pool, maybeOneRow } from './util'

export const getCampaign = async function(campaignId) {
    return pool.query(`
    SELECT
      c.*,
      to_json(u.*) "user"
    FROM campaigns c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = $1
  `, [campaignId]).then(maybeOneRow)
}

export const listCampaignsByActivity = async function() {
    return pool.query(`
    SELECT
      c.*,
      to_json(users.*) "user",
      to_json(r.*) "last_roll"
    FROM campaigns c
    JOIN users ON c.user_id = users.id
    LEFT OUTER JOIN rolls r ON c.last_roll_id = r.id
    ORDER BY c.last_roll_id DESC NULLS LAST
    LIMIT 100
  `).then(res => res.rows)
}

// Ordered by newest first
export const getCampaignsForUser = async function(userId) {
    assert(userId)
    return pool.query(`
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
  `, [userId]).then(res => res.rows)
}

export const getCampaignRolls = async function(campaignId) {
    assert(campaignId)
    return pool.query(`
    SELECT
      r.*,
      to_json(users.*) "user"
    FROM rolls r
    JOIN users ON r.user_id = users.id
    WHERE r.campaign_id = $1
    ORDER BY r.id DESC
    LIMIT 100
  `, [campaignId]).then(res => res.rows)
}

// markup is optional
export const updateCampaign = async function(campaignId, title, markup) {
    assert(Number.isInteger(campaignId))
    assert(typeof title === 'string')
    let html
    if (typeof markup === 'string') {
        html = bbcode(markup)
    }
    return pool.query(`
    UPDATE campaigns
    SET title = $1
      , markup = $2
      , html = $3
    WHERE id = $4
  `, [title, markup, html, campaignId]).then(maybeOneRow)
}

// markup is optional
export const insertCampaign = async function(userId, title, markup) {
    assert(Number.isInteger(userId))
    assert(typeof title === 'string')
    let html
    if (typeof markup === 'string') {
        html = bbcode(markup)
    }
    return pool.query(`
    INSERT INTO campaigns (user_id, title, markup, html)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [userId, title, markup, html]).then(maybeOneRow)
}

// note is optional
export const insertRoll = async function(userId, campaignId, syntax, note) {
    assert(Number.isInteger(userId))
    assert(Number.isInteger(campaignId))
    assert(typeof syntax === 'string')
    // throws if syntax is invalid. err.message for parser error message.
    const output = dice.roll(syntax)
    return pool.withTransaction(async client => {
        const roll = await client.query(`
      INSERT INTO rolls (user_id, campaign_id, syntax, rolls, total, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [userId, campaignId, syntax, JSON.stringify(output.rolls), output.total, note]).then(maybeOneRow)

        await client.query(`
      UPDATE campaigns
      SET last_roll_at = NOW()
        , roll_count = roll_count + 1
        , last_roll_id = $1
      WHERE id = $2
    `, [roll.id, campaignId])

        return roll
    })
}

export const getRoll = async function(rollId) {
    assert(rollId)
    return pool.query(`
    SELECT
      r.*,
      to_json(u.*) "user",
      to_json(c.*) "campaign"
    FROM rolls r
    JOIN users u ON r.user_id = u.id
    JOIN campaigns c ON r.campaign_id = c.id
    WHERE r.id = $1
  `, [rollId]).then(maybeOneRow)
}
