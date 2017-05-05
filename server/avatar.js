// Node
const path = require('path')
const nodeFs = require('fs')
const crypto = require('crypto')
const zlib = require('zlib')
// 3rd party
const assert = require('better-assert')
const gm = require('gm').subClass({ imageMagick: true })
const promissory = require('promissory')
const debug = require('debug')('app:avatar')
const Uploader = require('s3-streaming-upload').Uploader
const uuidGen = require('node-uuid')
// 1st party
var config = require('./config')

const getFormat = (fullInPath) => {
  return new Promise((resolve, reject) => {
    gm(fullInPath)
      .format((err, val) => {
        if (err) return reject(err)
        return resolve(val)
      })
  })
}

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
  let mime = data['Mime type'] || `image/${format}`

  // Gif mime is array on my computer, tho it worked on Heroku
  // without this bit...
  if (Array.isArray(mime)) {
    mime = mime[0]
    assert(typeof mime === 'string')
  }

  // :: Stream of the original uploaded image
  const inStream = nodeFs.createReadStream(fullInPath)

  const hashPromise = calcStreamHash(nodeFs.createReadStream(fullInPath))

  const gzip = zlib.createGzip()

  const handler = (resolve, reject) => {
    hashPromise.then((hash) => {
      const folderName = config.NODE_ENV === 'production' ? 'production' : 'development'
      const objectName = `${folderName}/${hash}.${format}`

      gm(inStream)
        // width, height, modifier
        // '>' = only resize if image exceeds dimensions
        // http://www.imagemagick.org/script/command-line-processing.php#geometry
        .resize(150, 200, '>')
        .strip() // Remove all metadata
        .stream(format, (err, processedImageReadStream) => {
          if (err) return reject(err);
          var uploader = new Uploader({
            stream: processedImageReadStream.pipe(gzip),
            accessKey: config.AWS_KEY,
            secretKey: config.AWS_SECRET,
            bucket: config.S3_AVATAR_BUCKET,
            objectName: objectName,
            objectParams: {
              'ContentType': mime,
              'CacheControl': 'max-age=31536000', // 1 year
              'ContentEncoding': 'gzip'
            }
          });
          uploader.send((err, data) => {
            if (err) return reject(err)
            const avatarUrl = data.Location
            return resolve(avatarUrl)
          })
        })
    }).catch(reject)
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
