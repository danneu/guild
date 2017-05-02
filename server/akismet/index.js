
// 3rd
const fetch = require('node-fetch')
const FormData = require('form-data')
const assert = require('better-assert')
// 1st
const config = require('../config')

////////////////////////////////////////////////////////////

exports.checkComment = async function ({
  userIp,  userAgent, referrer, commentType,
  commentAuthor, commentAuthorEmail, commentContent,
}) {
  if (!config.AKISMET_KEY) {
    throw new Error('[checkComment] AKISMET_KEY must be set')
  }

  assert(userIp)
  assert(userAgent)
  assert(referrer)
  assert(['forum-post', 'reply'].includes(commentType))
  assert(commentAuthor)
  assert(commentAuthorEmail)
  assert(commentContent)

  const url = `https://${config.AKISMET_KEY}.rest.akismet.com`

  const form = new FormData()
  form.append('blog', 'http://roleplayerguild.com')
  form.append('user_ip', userIp)
  form.append('comment_content', commentContent)
  form.append('comment_author', commentAuthor)
  form.append('blog_lang', 'en')
  form.append('blog_charset', 'UTF-8')
  form.append('is_test', config.NODE_ENV !== 'production')

  return fetch(url, { method: 'POST', body: form })
    .then((res) => res.text())
    .then((text) => text === 'valid')
}
