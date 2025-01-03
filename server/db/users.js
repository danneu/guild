'use strict'
// 3rd
const debug = require('debug')('app:db:dice')
const assert = require('better-assert')
const knex = require('knex')({ client: 'pg' })
const _ = require('lodash')
// 1st
const { pool } = require('./util')
const { sql } = require('pg-extra')

// Note: The db/*.js files are an ongoing effort to
// split apart the db/index.js monolith.

////////////////////////////////////////////////////////////

exports.getUserByEmail = async (email) => {
    const str = knex('users')
        .where('email', email)
        .first()
        .toString()
    const result = await pool._query(str)
    return result.rows[0]
}

// Generalized update function that takes an object of
// field/values to be updated.
exports.updateUser = async function(userId, fields) {
    assert(Number.isInteger(userId))
    assert(_.isPlainObject(fields))
    // Validate fields
    const WHITELIST = ['gender', 'email_verified']
    Object.keys(fields).forEach(key => {
        if (WHITELIST.indexOf(key) === -1) {
            throw new Error('FIELD_NOT_WHITELISTED')
        }
    })
    // Build SQL string
    const str = knex('users')
        .where({ id: userId })
        .update(fields)
        .toString()
    return pool._query(str)
}

////////////////////////////////////////////////////////////

exports.unapproveUser = async userId => {
    assert(Number.isInteger(userId))

    return pool.query(sql`
    UPDATE users
    SET approved_by_id = NULL,
        approved_at = NULL
    WHERE id = ${userId}
  `)
}

////////////////////////////////////////////////////////////

exports.approveUser = async ({ approvedBy, targetUser }) => {
    assert(Number.isInteger(approvedBy))
    assert(Number.isInteger(targetUser))

    return pool.query(sql`
    UPDATE users
    SET approved_by_id = ${approvedBy},
        approved_at = NOW()
    WHERE id = ${targetUser}
  `)
}

////////////////////////////////////////////////////////////
//Updates alts table: looks up the row with the alt's ID, then finds its owner ID, then updates all rows with the same owner ID. This merges two alt chains into one.
//SET: Grabs the owner_id of the user registering the alt (in case they're an alt of some other account)
//WHERE: Everyone owned by the same account as the current alt
exports.linkUserAlts = async function(userId, altId) {
  return pool.query(sql`
    UPDATE alts
    SET owner_id = (SELECT owner_id from alts WHERE id=${userId})
    WHERE owner_id = (SELECT owner_id FROM alts WHERE id = ${altId})
  `)
}

////////////////////////////////////////////////////////////
//First runs a query to find all accounts owned by the unlinked account. It sets the owner of all of those accounts to one of the other accounts in the pool (since there's no legit hierarchy)
//Then we set the ID of the unlinked account to itself, marking it as unowned. And due to the previous query, it won't be part of any pool.
exports.unlinkUserAlts = async function(userId) {
  await pool.query(sql`
    UPDATE alts
    SET owner_id = (
      SELECT MIN(id)
      FROM alts
      WHERE owner_id = ${userId}
      AND id <> ${userId}
  )
    WHERE owner_id = ${userId} AND id <> ${userId}`)

  return pool.query(sql`
    UPDATE alts
    SET owner_id = ${userId}
    WHERE id=${userId}`
  )
}
