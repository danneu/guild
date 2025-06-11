'use strict'
// 3rd
const debug = require('debug')('app:db:images')
const { assert } = require('../util')
const uuidGen = require('uuid')
const knex = require('knex')({ client: 'pg' })
const _ = require('lodash')
// 1st
const { pool } = require('./util')
const { sql } = require('pg-extra')

////////////////////////////////////////////////////////////

exports.getImage = async function(uuid) {
    assert(typeof uuid === 'string')
    return pool.one(sql`
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.id = ${uuid}
      AND deleted_at IS NULL
  `)
}

exports.getLatestImages = async function(limit = 10) {
    debug(`[getLatestImages]`)
    return pool.many(sql`
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.deleted_at IS NULL
    ORDER BY images.created_at DESC
    LIMIT ${limit}
  `)
}

exports.getUserAlbums = async function(userId) {
    assert(Number.isInteger(userId))
    return pool.many(sql`
    SELECT
      albums.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM albums
    JOIN users ON albums.user_id = users.id
    WHERE albums.user_id = ${userId}
    ORDER BY albums.created_at DESC
  `)
}

exports.getUserImages = async function(userId) {
    assert(Number.isInteger(userId))
    return pool.many(sql`
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.user_id = ${userId}
      AND images.deleted_at IS NULL
    ORDER BY images.created_at DESC
  `)
}

exports.getAlbumImages = async function(albumId) {
    assert(Number.isInteger(albumId))
    return pool.many(sql`
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.album_id = ${albumId}
      AND images.deleted_at IS NULL
    ORDER BY images.created_at DESC
  `)
}

// description is optional
exports.insertImage = async function(
    imageId,
    albumId,
    userId,
    src,
    mime,
    description
) {
    assert(typeof imageId === 'string')
    assert(Number.isInteger(userId))
    assert(Number.isInteger(albumId))
    assert(typeof src === 'string')
    assert(['image/jpeg', 'image/gif', 'image/png'].indexOf(mime) > -1)
    return pool.query(sql`
    INSERT INTO images (id, album_id, user_id, src, mime, description)
    VALUES (${imageId}, ${albumId}, ${userId}, ${src}, ${mime}, ${description})
  `)
}

// TODO: Also delete from S3
exports.deleteImage = async function(imageId) {
    assert(typeof imageId === 'string')
    return pool.query(sql`
    UPDATE images
    SET deleted_at = NOW()
    WHERE id = ${imageId}
  `)
}

// markup is optional
exports.insertAlbum = async function(userId, title, markup) {
    assert(Number.isInteger(userId))
    assert(typeof title === 'string')
    return pool.one(sql`
    INSERT INTO albums (user_id, title, markup)
    VALUES (${userId}, ${title}, ${markup})
    RETURNING *
  `)
}

exports.getAlbum = async function(albumId) {
    assert(albumId)
    return pool.one(sql`
    SELECT
      a.*,
      to_json(u.*) "user"
    FROM albums a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = ${albumId}
  `)
}

// Generalized update function that takes an object of
// field/values to be updated.
exports.updateAlbum = async function(albumId, fields) {
    assert(albumId)
    assert(_.isPlainObject(fields))
    // Validate fields
    const WHITELIST = ['title', 'markup']
    Object.keys(fields).forEach(key => {
        if (WHITELIST.indexOf(key) === -1) {
            throw new Error('FIELD_NOT_WHITELISTED')
        }
    })
    // Build SQL string
    const str = knex('albums')
        .where({ id: albumId })
        .update(fields)
        .toString()
    return pool._query(str)
}
