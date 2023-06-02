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
