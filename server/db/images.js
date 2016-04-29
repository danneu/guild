'use strict';
// 3rd
const assert = require('better-assert');
const uuidGen = require('node-uuid');
// 1st
const util = require('./util');

////////////////////////////////////////////////////////////

exports.getImage = function * (uuid) {
  assert(typeof uuid === 'string');
  const sql = `
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
  `;
  return yield util.queryOne(sql, [uuid]);
};

// limit is optional
exports.getLatestImages = function * (limit) {
  const sql = `
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    ORDER BY images.created_at DESC
    LIMIT $1
  `;
  return yield util.queryMany(sql, [limit || 10]);
};

exports.getUserAlbums = function * (userId) {
  assert(Number.isInteger(userId));
  const sql = `
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
  `;
  return yield util.queryMany(sql, [userId]);
};

exports.getUserImages = function * (userId) {
  assert(Number.isInteger(userId));
  const sql = `
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
  `;
  return yield util.queryMany(sql, [userId]);
};

exports.getAlbumImages = function * (albumId) {
  assert(Number.isInteger(albumId));
  const sql = `
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
  `;
  return yield util.queryMany(sql, [albumId]);
};
// description is optional
exports.insertImage = function * (imageId, albumId, userId, src, mime, description) {
  assert(typeof imageId === 'string');
  assert(Number.isInteger(userId));
  assert(Number.isInteger(albumId));
  assert(typeof src === 'string');
  assert(['image/jpeg', 'image/gif', 'image/png'].indexOf(mime) > -1);
  const sql = `
    INSERT INTO images (id, album_id, user_id, src, mime, description)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;
  return yield util.query(sql, [imageId, albumId, userId, src, mime, description]);
};

// TODO: Also delete from S3
exports.deleteImage = function * (imageId) {
  assert(typeof imageId === 'string');
  return yield util.query(`
    UPDATE images
    SET deleted_at = NOW()
    WHERE id = $1
  `, [imageId]);
};

// markup is optional
exports.insertAlbum = function * (userId, title, markup) {
  assert(Number.isInteger(userId));
  assert(typeof title === 'string');
  return yield util.query(`
    INSERT INTO albums (user_id, title, markup)
    VALUES ($1, $2, $3)
    RETURNING *
  `, [userId, title, markup]);
};

exports.getAlbum = function * (albumId) {
  assert(albumId);
  return yield util.queryOne(`
SELECT
  a.*,
  to_json(u.*) "user"
FROM albums a
JOIN users u ON a.user_id = u.id
WHERE a.id = $1
  `, [albumId]);
};
