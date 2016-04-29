'use strict';
// Node
const fs = require('fs');
// 3rd
const router = require('koa-router')();
const debug = require('debug')('routes:images');
const gm = require('gm').subClass({ imageMagick: true });
// 1st
const db = require('../db');
const pre = require('../presenters');

////////////////////////////////////////////////////////////

function * loadUser (next) {
  const user = yield db.getUserBySlug(this.params.user_slug);
  pre.presentUser(user);
  this.assert(user, 404);
  this.state.user = user;
  yield * next;
}

function * loadImageWithBlob (next) {
  const image = yield db.images.getImageWithBlob(this.params.image_id);
  pre.presentImage(image);
  this.assert(image, 404);
  this.state.image = image;
  yield * next;
}

function * loadImageWithoutBlob (next) {
  const image = yield db.images.getImageWithoutBlob(this.params.image_id);
  pre.presentImage(image);
  this.assert(image, 404);
  this.state.image = image;
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

router.get('/images/:image_id.:ext', loadImageWithBlob, function * () {
  this.assert(extToMime(this.params.ext) === this.state.image.mime, 404);
  this.set('Cache-Control', 'max-age=31556926');
  this.type = this.state.image.mime;
  this.body = this.state.image.blob;
});

router.get('/users/:user_slug/images/:image_id', loadUser, loadImageWithoutBlob, function * () {
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
  yield this.render('show_user_images', {
    ctx: this,
    images,
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

router.post('/users/:user_slug/images', loadUser, function * () {
  this.assertAuthorized(this.currUser, 'UPLOAD_IMAGE', this.state.user);
  // FIXME: Lame validation
  // fields
  this.assert(this.request.body.fields, 400);
  this.assert(typeof this.request.body.fields.description === 'string', 400);
  const description = this.request.body.fields.description;
  this.assert(description.length <= 10000, 400);
  // files
  this.assert(this.request.body.files, 400);
  this.assert(this.request.body.files.image, 400);
  const upload = this.request.body.files.image;
  this.assert(Number.isInteger(upload.size), 400);
  this.assert(typeof upload.path === 'string', 400);
  // ensure <= 10mb
  if (upload.size > 1e7) {
    this.flash = { message: ['danger', 'Image cannot exceed 10mb.'] };
    return this.redirect('back');
  }
  // { 'Mime type': 'image/jpeg' OR 'format': 'JPEG' }
  const data = yield identify(upload.path);
  const mime = identifyToMime(data);
  if (!mime || ['image/jpeg', 'image/png', 'image/gif'].indexOf(mime) < 0) {
    this.flash = { message: ['danger', 'Invalid image format. Must be jpg, gif, png.'] };
    return this.redirect('back');
  }

  // INSERT

  yield db.images.insertImage(this.state.user.id, yield readPath(upload.path), mime, description);

  // RESPOND

  this.flash = { message: ['success', 'Image uploaded'] };
  this.redirect(this.state.user.url + '/images');
});

////////////////////////////////////////////////////////////

module.exports = router;
