"use strict";
// Node
var path = require('path');
var nodeFs = require('fs');
var crypto = require('crypto');
// 3rd party
var gm = require('gm').subClass({ imageMagick: true });
var co = require('co');
var promissory = require('promissory');
var debug = require('debug')('app:avatar');
var Uploader = require('s3-streaming-upload').Uploader;
var uuidGen = require('node-uuid');
// 1st party
var config = require('./config');

var getFormat = function(fullInPath) {
  return new Promise(function(resolve, reject) {
    gm(fullInPath)
      .format(function(err, val) {
        if (err) return reject(err);
        return resolve(val);
      });
  });
};

var identify = function(fullInPath) {
  return new Promise(function(resolve, reject) {
    gm(fullInPath)
      .identify(function(err, val) {
        if (err) return reject(err);
        return resolve(val);
      });
  });
};

// Returns promise that resolves to hex hash string for given readable stream
var calcStreamHash = function(inStream) {
  return new Promise(function(resolve, reject) {
    var hash = crypto.createHash('sha1');
    hash.setEncoding('hex');

    inStream.on('end', function() {
      hash.end();
      debug('hash end');
      return resolve(hash.read());
    });

    inStream.on('error', function(ex) {
      debug('hash error');
      return reject(ex);
    });

    inStream.pipe(hash);
  });
};

exports.handleAvatar = function*(userId, fullInPath) {
  // Returns an object with these useful keys (among others):
  // - format: 'GIF'
  // - size: { width: 130, height: 133 }
  // - 'Mime type': 'image/gif'
  var data = yield identify(fullInPath);
  data['format'] = data['format'].toLowerCase();

  debug('format: ', data['format']);
  debug('size: ', data['size']);
  debug('Mime type: ', data['Mime type']);

  // :: Stream of the original uploaded image
  var inStream = nodeFs.createReadStream(fullInPath);

  var hashPromise = calcStreamHash(nodeFs.createReadStream(fullInPath));

  // FIXME: reject undefined. why did I write this?
  hashPromise.catch(function(ex) {
    return reject(ex);
  });

  var handler = function(resolve, reject) {
    hashPromise.then(function(hash) {
      var objectName = 'avatars/' + hash + '.' + data.format;

      gm(inStream)
        // width, height, modifier
        // '>' = only resize if image exceeds dimensions
        // http://www.imagemagick.org/script/command-line-processing.php#geometry
        .resize(150, 200, '>')
        .strip() // Remove all metadata
        .stream(data.format, function(err, processedImageReadStream) {
          if (err) return reject(err);
          var uploader = new Uploader({
            stream: processedImageReadStream,
            accessKey: config.AWS_KEY,
            secretKey: config.AWS_SECRET,
            bucket: config.S3_BUCKET,
            objectName: objectName,
            objectParams: {
              'ContentType': data['Mime type'],
              'CacheControl': 'max-age=31536000' // 1 year
            }
          });
          uploader.send(function(err, data) {
            if (err) return reject(err);
            var avatarUrl = data.Location;
            return resolve(avatarUrl);
          });
        });
    });
  };

  return new Promise(handler);
};

function readProcessWrite(inPath, outPath) {
  return new Promise(function(resolve, reject) {
    var fullInPath = path.resolve(inPath);
    var fullOutPath = path.resolve(outPath);
    gm(fullInPath)
      .autoOrient() // http://aheckmann.github.io/gm/docs.html#autoOrient
      .resize(150, 150)
      .strip() // http://aheckmann.github.io/gm/docs.html#strip
      .write(fullOutPath, function(err) {
        if (err) return reject(err);
        return resolve();
      });
  });
}

// function* run() {
//   var format = yield getFormat(path.resolve('avatar.jpg'));
//   debug('format: ', format);
//   return yield readProcessWrite('avatar.jpg', 'avatar-sm.jpg');
// }
// console.log('Starting');
// var succBack = function() { console.log('OK'); };
// var errBack = function(ex) { console.log('-_-');console.error(ex); throw ex; };
// co(run).then(succBack, errBack);
