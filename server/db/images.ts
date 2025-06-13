// 3rd
import createDebug from 'debug'
const debug = createDebug('app:db:images')
import assert from 'assert'
import Knex from 'knex'
const knex = Knex({ client: 'pg' })
import _ from 'lodash'
// 1st
import { pool, maybeOneRow } from './util.js'

////////////////////////////////////////////////////////////

export const getImage = async function(uuid) {
    assert(typeof uuid === 'string')
    return pool.query(`
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.id = $1
      AND deleted_at IS NULL
  `, [uuid]).then(maybeOneRow)
}

export const getLatestImages = async function(limit = 10) {
    debug(`[getLatestImages]`)
    return pool.query(`
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
    LIMIT $1
  `, [limit]).then(res => res.rows)
}

export const getUserAlbums = async function(userId) {
    assert(Number.isInteger(userId))
    return pool.query(`
    SELECT
      albums.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM albums
    JOIN users ON albums.user_id = users.id
    WHERE albums.user_id = $1
    ORDER BY albums.created_at DESC
  `, [userId]).then(res => res.rows)
}

export const getUserImages = async function(userId) {
    assert(Number.isInteger(userId))
    return pool.query(`
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.user_id = $1
      AND images.deleted_at IS NULL
    ORDER BY images.created_at DESC
  `, [userId]).then(res => res.rows)
}

export const getAlbumImages = async function(albumId) {
    assert(Number.isInteger(albumId))
    return pool.query(`
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.album_id = $1
      AND images.deleted_at IS NULL
    ORDER BY images.created_at DESC
  `, [albumId]).then(res => res.rows)
}

// description is optional
export const insertImage = async function(
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
    assert(['image/jpeg', 'image/gif', 'image/png', 'image/avif'].indexOf(mime) > -1)
    return pool.query(`
    INSERT INTO images (id, album_id, user_id, src, mime, description)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [imageId, albumId, userId, src, mime, description])
}

// TODO: Also delete from S3
export const deleteImage = async function(imageId) {
    assert(typeof imageId === 'string')
    return pool.query(`
    UPDATE images
    SET deleted_at = NOW()
    WHERE id = $1
  `, [imageId])
}

// markup is optional
export const insertAlbum = async function(userId, title, markup) {
    assert(Number.isInteger(userId))
    assert(typeof title === 'string')
    return pool.query(`
    INSERT INTO albums (user_id, title, markup)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [userId, title, markup]).then(maybeOneRow)
}

export const getAlbum = async function(albumId) {
    assert(albumId)
    return pool.query(`
    SELECT
      a.*,
      to_json(u.*) "user"
    FROM albums a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = $1
  `, [albumId]).then(maybeOneRow)
}

// Generalized update function that takes an object of
// field/values to be updated.
export const updateAlbum = async function(albumId, fields) {
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
    return pool.query(str)
}
