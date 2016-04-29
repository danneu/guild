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
      AND images.is_hidden = false
    ORDER BY images.created_at DESC
  `;
  return yield util.queryMany(sql, [userId]);
};

// description is optional
exports.insertImage = function * (imageId, userId, src, mime, description) {
  assert(typeof imageId === 'string');
  assert(Number.isInteger(userId));
  assert(typeof src === 'string');
  assert(['image/jpeg', 'image/gif', 'image/png'].indexOf(mime) > -1);
  const sql = `
    INSERT INTO images (id, user_id, src, mime, description)
    VALUES ($1, $2, $3, $4, $5)
  `;
  return yield util.query(sql, [imageId, userId, src, mime, description]);
};

// TODO: Also delete from S3
// TODO: Mark as hidden
exports.deleteImage = function * (imageId) {
  assert(typeof imageId === 'string');
  return yield util.query(`
    DELETE FROM images
    WHERE id = $1
  `, [imageId]);
};
