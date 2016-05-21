'use strict';
// Node
const fs = require('fs');
// 3rd
const assert = require('better-assert');
const router = require('koa-router')();
const debug = require('debug')('app:routes:images');
const gm = require('gm').subClass({ imageMagick: true });
const Uploader = require('s3-streaming-upload').Uploader;
const uuidGen = require('node-uuid');
const AWS = require('aws-sdk');
// 1st
const db = require('../db');
const pre = require('../presenters');
const config = require('../config');

////////////////////////////////////////////////////////////

const s3 = new AWS.S3({ apiVersion: '2006-03-01' });

////////////////////////////////////////////////////////////

function * loadUser (next) {
  const user = yield db.getUserBySlug(this.params.user_slug);
  pre.presentUser(user);
  this.assert(user, 404);
  this.state.user = user;
  yield * next;
}

function * loadImage (next) {
  const image = yield db.images.getImage(this.params.image_id);
  pre.presentImage(image);
  this.assert(image, 404);
  this.state.image = image;
  yield * next;
}

function * loadAlbum (next) {
  const album = yield db.images.getAlbum(this.params.album_id);
  pre.presentAlbum(album);
  this.assert(album, 404);
  this.state.album = album;
  yield * next;
}

////////////////////////////////////////////////////////////

// ImageMagick identify object -> Mimetype string
function identifyToMime (data) {
  if (data['Mime type']) {
    return data['Mime type'];
  }
  switch (data.format) {
    case 'GIF': return 'image/gif';
    case 'JPEG': return 'image/jpeg';
    case 'PNG': return 'image/png';
  }
}

function extToMime (ext) {
  switch (ext) {
    case 'gif': return 'image/gif';
    case 'jpg': return 'image/jpeg';
    case 'png': return 'image/png';
  }
}

function mimeToExt (mime) {
  switch (mime) {
    case 'image/gif': return 'gif';
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
  }
}

router.get('/images/:image_id.:ext', loadImage, function * () {
  this.assert(extToMime(this.params.ext) === this.state.image.mime, 404);
  this.set('Cache-Control', 'max-age=31556926');
  this.type = this.state.image.mime;
  this.body = this.state.image.blob;
});

router.get('/users/:user_slug/images/:image_id', loadUser, loadImage, function * () {
  yield this.render('show_user_image', {
    ctx: this,
    image: this.state.image,
    user: this.state.user,
    title: 'Image'
  });
});

router.get('/users/:user_slug/images', loadUser, function * () {
  // template: views/show_user_images.html
  const images = yield db.images.getUserImages(this.state.user.id);
  images.forEach(pre.presentImage);
  const albums = yield db.images.getUserAlbums(this.state.user.id);
  albums.forEach(pre.presentAlbum);
  yield this.render('show_user_images', {
    ctx: this,
    images,
    albums,
    user: this.state.user,
    title: `${this.state.user.uname}'s Images`
  });
});

////////////////////////////////////////////////////////////
// Upload

function identify (path) {
  return new Promise(function (resolve, reject) {
    gm(path)
      .identify(function (err, val) {
        if (err) return reject(err);
        return resolve(val);
      });
  });
}

// String -> Buffer
function readPath (path) {
  return new Promise(function (resolve, reject) {
    fs.readFile(path, function (err, buf) {
      if (err) return reject(err);
      return resolve(buf);
    });
  });
}

// returns promise that resolves into s3 url of uploaded image
function uploadImage (key, path, mime) {
  assert(typeof key === 'string');
  assert(typeof path === 'string');
  assert(typeof mime === 'string');
  const inStream = fs.createReadStream(path);
  const uploader = new Uploader({
    stream: inStream,
    accessKey: config.AWS_KEY,
    secretKey: config.AWS_SECRET,
    bucket: config.S3_IMAGE_BUCKET,
    objectName: key,
    objectParams: {
      'ContentType': mime,
      'CacheControl': 'max-age=31536000' // 1 year
    }
  });
  return new Promise(function (resolve, reject) {
    uploader.send(function (err, data) {
      if (err) return reject(err);
      const srcUrl = data.Location;
      assert(typeof srcUrl === 'string');
      return resolve(srcUrl);
    });
  });
}

function deleteObject (key) {
  const params = {
    'Bucket': config.S3_IMAGE_BUCKET,
    'Key': key
  };
  return new Promise(function (resolve, reject) {
    s3.deleteObject(params, function (err, data) {
      if (err) return reject(err);
      return resolve();
    });
  });
}

router.post('/users/:user_slug/images', loadUser, function * () {
  if (!config.S3_IMAGE_BUCKET) {
    return this.body = 'The upload system is currently offline. (Bucket unspecified)';
  }
  this.assertAuthorized(this.currUser, 'UPLOAD_IMAGE', this.state.user);
  // FIXME: Lame validation
  // fields
  this.assert(this.request.body.fields, 400);
  this.assert(typeof this.request.body.fields.description === 'string', 400);
  const description = this.request.body.fields.description;
  this.assert(description.length <= 10000, 400);
  const albumId = this.request.body.fields.album_id;
  this.assert(Number.parseInt(albumId), 400);
  const album = yield db.images.getAlbum(albumId);
  this.assert(album, 404);
  // files
  this.assert(this.request.body.files, 400);
  this.assert(this.request.body.files.image, 400);
  const upload = this.request.body.files.image;
  this.assert(Number.isInteger(upload.size), 400);
  this.assert(typeof upload.path === 'string', 400);
  // ensure max upload size
  if (upload.size > 2e6) {
    this.flash = { message: ['danger', `Image cannot exceed 2 MB. Max: 2,000,000. Yours: ${upload.size}`] };
    return this.redirect('back');
  }
  // { 'Mime type': 'image/jpeg' OR 'format': 'JPEG' }
  const data = yield identify(upload.path);
  const mime = identifyToMime(data);
  if (!mime || ['image/jpeg', 'image/png', 'image/gif'].indexOf(mime) < 0) {
    this.flash = { message: ['danger', 'Invalid image format. Must be jpg, gif, png.'] };
    return this.redirect('back');
  }

  // UPLOAD

  const uuid = uuidGen.v4();
  const envFolder = config.NODE_ENV === 'production' ? 'prod' : 'dev';
  const s3Key = `${envFolder}/users/${uuid}.${mimeToExt(mime)}`;
  const url = yield uploadImage(s3Key, upload.path, mime);

  // INSERT

  yield db.images.insertImage(uuid, album.id, this.state.user.id, url, mime, description);

  // RESPOND

  this.flash = { message: ['success', 'Image uploaded'] };
  this.redirect(this.state.user.url + '/images');
});

// TODO: Also delete from S3
router.del('/users/:user_slug/images/:image_id', loadUser, loadImage, function * () {
  this.assertAuthorized(this.currUser, 'MANAGE_IMAGES', this.state.user);
  yield db.images.deleteImage(this.state.image.id);
  this.flash = { message: ['success', 'Image deleted'] };
  this.redirect(this.state.user.url + '/images');
});

// albums

router.get('/albums/:album_id', loadAlbum, function * () {
  const images = yield db.images.getAlbumImages(this.state.album.id);
  images.forEach(pre.presentImage);
  yield this.render('show_album', {
    ctx: this,
    user: this.state.album.user,
    album: this.state.album,
    images
  });
});

// update album
//
// Body:
// - title: Required String
// - markup: Optional String
router.put('/users/:user_slug/albums/:album_id', loadUser, loadAlbum, function * () {
  // AUTHZ
  this.assertAuthorized(this.currUser, 'MANAGE_IMAGES', this.state.user);
  // VALIDATE
  this.validateBody('title')
    .isString()
    .isLength(1, 300, 'Title must be 1-300 chars');
  this.validateBody('markup')
    .toString()
    .isLength(0, 10000, 'Description cannot be more than 10k chars');
  // SAVE
  yield db.images.updateAlbum(this.state.album.id, {
    title: this.vals.title,
    markup: this.vals.markup
  });
  // RESPOND
  this.flash = { message: ['success', 'Album updated'] };
  this.redirect(this.state.album.url);
});

router.post('/users/:user_slug/albums', loadUser, function * () {
  this.assertAuthorized(this.currUser, 'MANAGE_IMAGES', this.state.user);
  this.validateBody('title')
    .isString()
    .isLength(1, 300, 'Title must be 1-300 chars');
  this.validateBody('markup')
    .isLength(0, 10000, 'Description cannot be more than 10k chars');
  const album = yield db.images.insertAlbum(this.state.user.id, this.vals.title, this.vals.markup);
  pre.presentAlbum(album);
  this.flash = { message: ['success', 'Album created'] };
  this.redirect(album.url);
});


////////////////////////////////////////////////////////////

module.exports = router;
