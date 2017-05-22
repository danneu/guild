// Node
const zlib = require('zlib')
const path = require('path')
// 3rd
const {sql} = require('pg-extra')
const fetch = require('node-fetch')
const Uploader = require('s3-streaming-upload').Uploader
const promiseMap = require('promise.map')
// 1st
const config = require('../server/config')
const {pool} = require('../server/db/util')

////////////////////////////////////////////////////////////

function extToType (ext) {
  switch (ext) {
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.png':
      return 'image/png'
    case '.bmp':
      return 'image/bmp'
    default:
      throw new Error('unknown ext: ' + ext)
  }
}

async function getUsersWithOldAvatarUrls () {
  return pool.many(sql`
    SELECT id, uname, avatar_url
    FROM users
    WHERE avatar_url LIKE 'https://rpguild-prod.s3.amazonaws.com/avatars/%'
  `)
}

async function updateUser (userId, avatarUrl) {
  return pool.query(sql`
    UPDATE users
    SET avatar_url = ${avatarUrl}
    WHERE id = ${userId}
  `)
}

// Returns Promise<newAvatarUrl>
async function upload (user) {
  console.log('fetching url:', user.avatar_url)
  const res = await fetch(user.avatar_url)
  const gzip = zlib.createGzip()
  const [_, fileName] = require('url')
    .parse(user.avatar_url)
    .path
    .match(/\/avatars\/(.+)$/)
  const contentType = extToType(path.extname(fileName))
  console.log('content-type:', contentType)
  const objectName = `production/${fileName}`
  console.log('objectName:', objectName)
  const uploader = new Uploader({
    stream: res.body.pipe(gzip),
    accessKey: config.AWS_KEY,
    secretKey: config.AWS_SECRET,
    bucket: config.S3_AVATAR_BUCKET,
    objectName,
    objectParams: {
      'ContentType': contentType,
      'CacheControl': 'max-age=31536000', // 1 year
      'ContentEncoding': 'gzip'
    }
  })
  return new Promise((resolve, reject) => {
    uploader.send((err, data) => {
      if (err) return reject(err)
      const newAvatarUrl = data.Location
      return resolve(newAvatarUrl)
    })
  })
}

async function run () {
  const users = await getUsersWithOldAvatarUrls()
  console.log('users:', users.length)
  return promiseMap(users, async (user) => { 
    const newAvatarUrl = await upload(user)
    await updateUser(user.id, newAvatarUrl)
    console.log('[saved] newAvatarUrl:', newAvatarUrl, user.uname)
  }, 8)
}


run()
  .then(() => console.log('done'))
  .catch((err) => console.error(err))
