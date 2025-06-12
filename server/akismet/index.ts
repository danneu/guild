// 3rd
const debug = require('debug')('app:akismet')
const fetch = require('node-fetch')
const FormData = require('form-data')
const assert = require('assert')
// 1st
const config = require('../config')

////////////////////////////////////////////////////////////

// Returns Promise<boolean>
exports.checkComment = async function({
    userIp,
    userAgent,
    referrer,
    commentType,
    commentAuthor,
    commentAuthorEmail,
    commentContent,
}) {
    if (!config.AKISMET_KEY) {
        throw new Error('[checkComment] AKISMET_KEY must be set')
    }

    assert(userIp)
    assert(userAgent)
    assert(commentAuthor)
    assert(commentContent)
    assert(
        [
            'comment', // blog comment
            'forum-post', // top-level forum post
            'reply', // reply to top-level forum post
            'blog-post',
            'contact-form',
            'signup', // new user account
            'message', // message sent between just a few users
        ].includes(commentType)
    )

    const url = `https://${
        config.AKISMET_KEY
    }.rest.akismet.com/1.1/comment-check`

    const form = new FormData()
    form.append('blog', 'https://roleplayerguild.com')
    form.append('user_ip', userIp)
    form.append('user_agent', userAgent)
    form.append('comment_author', commentAuthor)
    form.append('comment_type', commentType)
    form.append('blog_lang', 'en')
    form.append('blog_charset', 'UTF-8')

    if (config.NODE_ENV !== 'production') {
        form.append('is_test', 'true')
    }

    // Optional

    if (commentContent) {
        form.append('comment_content', commentContent)
    }
    if (commentAuthorEmail) {
        form.append('comment_author_email', commentAuthorEmail)
    }

    return fetch(url, { method: 'POST', body: form })
        .then(res => res.text())
        .then(text => text === 'true')
}
