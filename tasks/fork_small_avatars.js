
// // Node
// const fs = require('fs')
// // 3rd
// const { assert } = require('../server/util')
// const Uploader = require('s3-streaming-upload').Uploader
// const {sql} = require('pg-extra')
// const gm = require('gm').subClass({ imageMagick: true })
// const fetch = require('node-fetch')
// const makeQueue = require('promise-task-queue')
// // 1st
// const config = require('../server/config')
// const {pool} = require('../server/db/util')

// //
// // This task takes every /production/:hash.:ext avatar, creates a resized
// // copy of max dimensions 32x32, and uploads it to /production/32/:hash.:ext
// //

// const prefix = config.NODE_ENV === 'production'
//   ? 'production'
//   : 'development'

// const queue = makeQueue()

// queue.define('process', async (avatar) => {
//   const response = await fetch(avatar.url)
//   const mime = response.headers.get('content-type')
//   if (!['image/jpeg', 'image/gif', 'image/png', 'image/bmp'].includes(mime)) {
//     throw new Error('unexpected mime:' + mime)
//   }
//   const stream = await resize(response.body)
//   const objectName = `${prefix}/32/${avatar.hash}.${avatar.ext}`
//   const newUrl = await upload({ mime, stream, objectName })
//   console.log(`uploaded ${avatar.url}\n-> ${newUrl}`)
// }, { concurrency: 12 })

// // { url, hash, ext }
// async function listAvatars () {
//   return pool.many(sql`
//     SELECT avatar_url
//     FROM users
//     WHERE avatar_url IS NOT NULL
//       AND char_length(avatar_url) > 3
//   `).then((xs) => xs.map((x) => {
//     const url = x.avatar_url
//     const [_, hash, ext] = require('url')
//       .parse(url)
//       .pathname
//       .match(new RegExp(`/${prefix}/([a-f0-9]+)\.(.+)$`))
//     if (![url, hash, ext].every(Boolean)) {
//       throw new Error('url, hash, or ext are falsey')
//     }
//     return {url, hash, ext}
//   }))
// }

// // Returns Promise<inputStream> of resized image
// async function resize (stream) {
//   return gm(stream)
//     .resize(32, 32, '>')
//     .stream()
// }

// async function upload ({objectName, mime, stream}) {
//   assert(typeof objectName === 'string')
//   assert(typeof mime === 'string')
//   assert(stream)

//   const uploader = new Uploader({
//     stream,
//     objectName,
//     accessKey: config.AWS_KEY,
//     secretKey: config.AWS_SECRET,
//     bucket: config.S3_AVATAR_BUCKET,
//     objectParams: {
//       'ContentType': mime,
//       'CacheControl': 'max-age=31536000' // 1 year
//     }
//   })

//   return new Promise((resolve, reject) => {
//     uploader.send((err, data) => {
//       if (err) return reject(err)
//       const newAvatarUrl = data.Location
//       return resolve(newAvatarUrl)
//     })
//   })
// }

// async function run () {
//   const avatars = await listAvatars()

//   avatars.forEach((avatar) => {
//     queue.push('process', avatar)
//       .catch((err) => {
//         console.error(`problem with avatar ${JSON.stringify(avatar)}`, err)
//       })
//   })
// }

// run()
// .then(() => console.log('done'))
// .catch((err) => console.error(err))
