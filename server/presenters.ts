'use strict'
// Node
var util = require('util')
var nodeUrl = require('url')
// 3rd party
var _ = require('lodash')
var debug = require('debug')('app:presenters')
// 1st party
var belt = require('./belt')
var config = require('./config')

/*
   Presenters should mutate*return the obj passed in, and handle null
*/

// Util ////////////////////////////////////////////////////

// Ex: formatDate(d) -> '8 Dec 2014 16:24'
exports.formatDate = formatDate
function formatDate(d) {
    // HACK: Help me realize when I call formatDate when there is no date in dev
    if (config.NODE_ENV === 'development' && !d) {
        return '[DATE WAS UNDEFINED]'
    }

    var months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ]
    var mins = d.getMinutes()
    // Pad mins to format "XX". e.g. 8 -> "08", 10 -> "10"
    var paddedMins = mins < 10 ? '0' + mins : mins
    return [
        d.getDate(),
        months[d.getMonth()],
        d.getFullYear(),
        d.getHours() + ':' + paddedMins,
    ].join(' ')
}

// Number -> String
// Ex: numWithCommas(10000) => '10,000'
function numWithCommas(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

////////////////////////////////////////////////////////////

exports.presentForum = function(forum) {
    if (!forum) return null

    forum.url = '/forums/' + belt.slugify(forum.id, forum.title)

    exports.presentForum(forum.parent_forum)
    exports.presentForum(forum.child_forum)

    if (forum.mods) {
        forum.mods.forEach(exports.presentUser)
    }
    if (forum.topics) {
        forum.topics.forEach(exports.presentTopic)
    }
    if (forum.forums) {
        forum.forums.forEach(exports.presentForum)
    }

    // For findForum2
    if (Array.isArray(forum.child_forums)) {
        forum.child_forums.forEach(exports.presentForum)
    }
    if (Array.isArray(forum.sibling_forums)) {
        forum.sibling_forums.forEach(exports.presentForum)
    }

    exports.presentPost(forum.latest_post)
    exports.presentUser(forum.latest_user)

    return forum
}

exports.presentUser = function(user) {
    if (!user) return null

    user.url = '/users/' + user.slug

    delete user.digest

    if (user.is_nuked) {
        user.bio_markup = null
        user.bio_html = null
        user.sig_html = ''
        user.sig = ''
        user.avatar_url = ''
        user.custom_title = ''
    }

    exports.presentUser(user.nuked_by)
    exports.presentUser(user.approved_by)

    // Reminder: Only avatar uploads since the S3 bucket update will
    // be served from the avatars.roleplayeguild.com bucket,
    // so here we'll check for that and only write those to go through
    // our avatars subdomain
    if (user.avatar_url) {
        const parsed = nodeUrl.parse(user.avatar_url)
        if (parsed.pathname.startsWith('/avatars.roleplayerguild.com/')) {
            user.avatar_url = 'https://' + parsed.pathname.slice(1)
        }

        user.avatar_url_sm = user.avatar_url.replace(
            /\/([a-f0-9\-]+\.[a-z]+)$/,
            '/32/$1'
        )
    }

    if (user.id === 1485) {
        user.posts_count += 30000
    }

    // Fix embedded
    if (_.isString(user.created_at)) user.created_at = new Date(user.created_at)
    if (_.isString(user.last_online_at))
        user.last_online_at = new Date(user.last_online_at)

    return user
}

exports.presentTopic = function(topic) {
    if (!topic) return null

    topic.url = '/topics/' + belt.slugify(topic.id, topic.title)

    // created_at will be string when embedded in query result via to_json
    if (_.isString(topic.created_at))
        topic.created_at = new Date(topic.created_at)

    // Subs
    topic.subscriptionUrl = '/me/subscriptions/' + topic.id

    if (topic.posts) topic.posts.forEach(exports.presentPost)
    exports.presentForum(topic.forum)
    exports.presentUser(topic.user)

    //// Check for cache props
    // Post caches
    exports.presentPost(topic.latest_post)
    exports.presentPost(topic.latest_ic_post)
    exports.presentPost(topic.latest_ooc_post)
    exports.presentPost(topic.latest_char_post)
    // User caches
    exports.presentUser(topic.latest_user)
    exports.presentUser(topic.latest_ic_user)
    exports.presentUser(topic.latest_ooc_user)
    exports.presentUser(topic.latest_char_user)

    return topic
}

exports.presentCategory = function(category) {
    if (!category) return null

    if (category.forums) {
        category.forums.forEach(exports.presentForum)
    }

    return category
}

exports.presentConvo = function(convo) {
    if (!convo) return null

    if (_.isString(convo.created_at))
        convo.created_at = new Date(convo.created_at)

    convo.url = '/convos/' + convo.id

    exports.presentUser(convo.user)
    if (convo.participants) convo.participants.forEach(exports.presentUser)
    if (convo.pms) convo.pms.forEach(exports.presentPm)
    exports.presentUser(convo.latest_user)
    exports.presentPm(convo.latest_pm)

    return convo
}

exports.presentPost = function(post) {
    if (!post) return null

    if (_.isString(post.created_at)) post.created_at = new Date(post.created_at)
    // updated_at is null if post hasn't been edited
    if (_.isString(post.updated_at)) post.updated_at = new Date(post.updated_at)
    if (post.updated_at) post.formattedUpdatedAt = formatDate(post.updated_at)
    post.url = '/posts/' + post.id
    exports.presentUser(post.user)
    exports.presentTopic(post.topic)
    exports.presentForum(post.forum)
    return post
}

exports.presentPm = function(pm) {
    if (!pm) return null
    if (_.isString(pm.created_at)) pm.created_at = new Date(pm.created_at)
    pm.formattedCreatedAt = formatDate(pm.created_at)
    pm.url = '/pms/' + pm.id

    exports.presentUser(pm.user)
    exports.presentConvo(pm.convo)

    return pm
}

exports.presentNotification = function(n) {
    if (!n) return null

    exports.presentTopic(n.topic)
    exports.presentConvo(n.convo)
    exports.presentPost(n.post)

    return n
}

////////////////////////////////////////////////////////////

exports.presentStatus = function(x) {
    if (!x) return null

    exports.presentUser(x.user)

    return x
}

exports.presentTrophy = function(t) {
    if (!t) return null

    t.url = '/trophies/' + t.id

    // awarded_by is normally a user_id, but it should be SELECT'd
    // as a json object of the user that awarded the trophy
    exports.presentUser(t.awarded_by)

    if (t.winners) t.winners.forEach(exports.presentUser)

    return t
}

////////////////////////////////////////////////////////////

exports.presentFriendship = function(f) {
    if (!f) return null

    exports.presentUser(f.to_user)

    return f
}

exports.presentVm = function(vm) {
    if (!vm) return null

    vm.url = `/vms/${vm.id}`

    // Fix embedded

    if (_.isString(vm.created_at)) {
        vm.created_at = new Date(vm.created_at)
    }

    exports.presentUser(vm.from_user)
    exports.presentUser(vm.to_user)

    if (vm.child_vms) {
        vm.child_vms.forEach(exports.presentVm)
    }

    return vm
}

////////////////////////////////////////////////////////////

exports.presentKeyval = function(x) {
    if (!x) return null

    exports.presentUser(x.updated_by)

    return x
}

////////////////////////////////////////////////////////////

exports.presentImage = function(x) {
    if (!x) return null

    exports.presentUser(x.user)

    // Legacy image url: https://s3.amazonaws.com/img.roleplayerguild.com/prod/users/0001999e-ac95-468b-a526-0fd8ffc8591b.png
    // New image url: https://img.roleplayerguild.com/prod/users/0001999e-ac95-468b-a526-0fd8ffc8591b.avif

    const url = new URL(x.src)
    if (url.hostname === 's3.amazonaws.com') {
        // Legacy image url needs to be transformed
        x.src = 'https://' + url.pathname.slice(1)
    } else {
        // New url is already correct
        x.src = url.toString()
    }

    return x
}

exports.presentAlbum = function(x) {
    if (!x) return null
    exports.presentUser(x.user)
    x.url = `/albums/${x.id}`
    return x
}

// DICE

exports.presentCampaign = function(x) {
    if (!x) return null
    exports.presentUser(x.user)
    exports.presentRoll(x.last_roll)
    x.url = `/campaigns/${x.id}`
    return x
}

exports.presentRoll = function(x) {
    if (!x) return null
    exports.presentUser(x.user)
    exports.presentCampaign(x.campaign)
    x.absoluteUrl = `${config.HOST}/rolls/${x.id}`
    x.url = `/rolls/${x.id}`
    return x
}

exports.presentTag = function(x) {
    if (!x) return null

    if (typeof x.created_at === 'string') {
        x.created_at = new Date(x.created_at)
    }

    x.url = `/tags/${x.id}`

    return x
}

exports.presentTagGroup = function(x) {
    if (!x) return null

    if (x.tags) {
        x.tags.forEach(exports.presentTag)
    }

    x.url = `/tag-groups/${x.id}`

    return x
}

exports.presentTopicBan = function(x) {
    if (!x) return null

    x.url = `/topic-bans/${x.id}`

    exports.presentUser(x.banned)
    exports.presentUser(x.banned_by)

    return x
}

exports.presentPostRev = function(x) {
    if (!x) return null

    x.url = `/posts/${x.post_id}/revisions/${x.id}`

    exports.presentUser(x.user)

    return x
}

exports.presentUnameChange = function(x) {
    if (!x) return null

    exports.presentUser(x.user)
    exports.presentUser(x.changed_by)

    return x
}
