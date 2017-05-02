// Node
var path = require('path')
var nodeFs = require('fs')
var crypto = require('crypto')
// 3rd party
var gm = require('gm').subClass({ imageMagick: true });
var promissory = require('promissory');
var debug = require('debug')('app:avatar');
var Uploader = require('s3-streaming-upload').Uploader;
var uuidGen = require('node-uuid');
// 1st party
var config = require('./config');

const getFormat = (fullInPath) => {
  return new Promise((resolve, reject) => {
    gm(fullInPath)
      .format(function(err, val) {
        if (err) return reject(err);
        return resolve(val);
      });
  });
};

const identify = (fullInPath) => {
  return new Promise((resolve, reject) => {
    gm(fullInPath)
      .identify((err, val) => {
        if (err) return reject(err)
        return resolve(val)
      })
  })
}

// Returns promise that resolves to hex hash string for given readable stream
const calcStreamHash = (inStream) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    hash.setEncoding('hex')

    inStream.on('end', () => {
      hash.end()
      debug('hash end')
      return resolve(hash.read())
    })

    inStream.on('error', (ex) => {
      debug('hash error')
      return reject(ex)
    })

    inStream.pipe(hash)
  })
}

exports.handleAvatar = async (userId, fullInPath) => {
  // Returns an object with these useful keys (among others):
  // - format: 'GIF'
  // - size: { width: 130, height: 133 }
  // - 'Mime type': 'image/gif'
  const data = await identify(fullInPath)
  debug('size: ', data['size'])
  const format = data['format'].toLowerCase()
  // data['Mime type'] is never set on the Heroku dyno, only exists locally...
  const mime = data['Mime type'] || `image/${format}`

  // :: Stream of the original uploaded image
  const inStream = nodeFs.createReadStream(fullInPath)

  const hashPromise = calcStreamHash(nodeFs.createReadStream(fullInPath))

  // FIXME: reject undefined. why did I write this?
  hashPromise.catch((ex) => {
    return reject(ex)
  });

  const handler = (resolve, reject) => {
    hashPromise.then((hash) => {
      var folderName = config.NODE_ENV === 'production' ? 'production' : 'development';
      var objectName = `${folderName}/${hash}.${format}`;

      gm(inStream)
        // width, height, modifier
        // '>' = only resize if image exceeds dimensions
        // http://www.imagemagick.org/script/command-line-processing.php#geometry
        .resize(150, 200, '>')
        .strip() // Remove all metadata
        .stream(format, (err, processedImageReadStream) => {
          if (err) return reject(err);
          var uploader = new Uploader({
            stream: processedImageReadStream,
            accessKey: config.AWS_KEY,
            secretKey: config.AWS_SECRET,
            bucket: config.S3_AVATAR_BUCKET,
            objectName: objectName,
            objectParams: {
              'ContentType': mime,
              'CacheControl': 'max-age=31536000' // 1 year
            }
          });
          uploader.send((err, data) => {
            if (err) return reject(err)
            const avatarUrl = data.Location
            return resolve(avatarUrl)
          })
        })
    })
  }

  return new Promise(handler)
}

function readProcessWrite (inPath, outPath) {
  return new Promise((resolve, reject) => {
    var fullInPath = path.resolve(inPath)
    var fullOutPath = path.resolve(outPath)
    gm(fullInPath)
      .autoOrient() // http://aheckmann.github.io/gm/docs.html#autoOrient
      .resize(150, 150)
      .strip() // http://aheckmann.github.io/gm/docs.html#strip
      .write(fullOutPath, (err) => {
        if (err) return reject(err)
        return resolve()
      })
  })
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
