// Node
import { URL } from 'url'
import crypto from 'crypto'
// 3rd party
import createDebug from 'debug'
const debug = createDebug('app:belt')
import assert from 'assert'
import bcrypt from 'bcryptjs'
import _ from 'lodash'
import Autolinker from 'autolinker'
// 1st party
import * as config from './config'

////
//// This module is a general utility-belt of functions.
//// Somewhat of a junk drawer.
////

export const dateToSeconds = function(date) {
    return Math.floor(date.getTime() / 1000)
}

// Not sure what I was doing here.
function dateToUTC(date: Date) {
    return new Date(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds()
    )
}

// Not sure what I was doing here.
export function getUTCDate(date: Date): Date {
    return dateToUTC(date)
}

export const isNewerThan = function(nowDate: Date, opts) {
    assert(nowDate instanceof Date)
    return nowDate > pastDate(new Date(), opts)
}

export const isOlderThan = function(nowDate: Date, opts) {
    assert(nowDate instanceof Date)
    return nowDate < pastDate(new Date(), opts)
}

type TimeSpan = {
    years?: number
    months?: number
    days?: number
    hours?: number
    minutes?: number
    seconds?: number
    milliseconds?: number
}

export function pastDate(opts: TimeSpan): Date
export function pastDate(nowDate: Date, opts: TimeSpan): Date

export function pastDate(nowDateOrOpts: Date | TimeSpan, opts?: TimeSpan): Date {
    let nowDate: Date
    let span: TimeSpan

    if (opts === undefined) {
        // First overload: pastDate(opts)
        nowDate = new Date()
        span = nowDateOrOpts as TimeSpan
    } else {
        // Second overload: pastDate(nowDate, opts)
        nowDate = nowDateOrOpts as Date
        span = opts
    }

    return new Date(
        nowDate.getTime() -
            ((span.years || 0) * 1000 * 60 * 60 * 24 * 365 +
                (span.months || 0) * 1000 * 60 * 60 * 24 * 30 +
                (span.days || 0) * 1000 * 60 * 60 * 24 +
                (span.hours || 0) * 1000 * 60 * 60 +
                (span.minutes || 0) * 1000 * 60 +
                (span.seconds || 0) * 1000 +
                (span.milliseconds || 0))
    )
}

export function futureDate(opts: TimeSpan): Date
export function futureDate(nowDate: Date, opts: TimeSpan): Date

export function futureDate(nowDateOrOpts: Date | TimeSpan, opts?: TimeSpan): Date {
    let nowDate: Date
    let span: TimeSpan

    if (opts === undefined) {
        // First overload: futureDate(opts)
        nowDate = new Date()
        span = nowDateOrOpts as TimeSpan
    } else {
        // Second overload: futureDate(nowDate, opts)
        nowDate = nowDateOrOpts as Date
        span = opts
    }

    return new Date(
        nowDate.getTime() +
            (span.years || 0) * 1000 * 60 * 60 * 24 * 365 +
            (span.months || 0) * 1000 * 60 * 60 * 24 * 30 +
            (span.days || 0) * 1000 * 60 * 60 * 24 +
            (span.hours || 0) * 1000 * 60 * 60 +
            (span.minutes || 0) * 1000 * 60 +
            (span.seconds || 0) * 1000 +
            (span.milliseconds || 0)
    )
}

export const md5 = function(s) {
    return crypto
        .createHash('md5')
        .update(s)
        .digest('hex')
}

// {{ 'firetruck'|truncate(5) }}  -> 'firet...'
// {{ 'firetruck'|truncate(6) }}  -> 'firetruck'
export const makeTruncate = function(suffix) {
    return function(str, n) {
        if (!str) return str
        suffix = suffix || ''
        var sliced = str.slice(0, n).trim()
        var totalLength = sliced.length + suffix.length
        if (totalLength >= str.length) return str
        return sliced + suffix
    }
}

export const truncate = makeTruncate('...')

// Logging helper
export const truncateStringVals = function(obj) {
    var out = {}
    for (var k in obj) {
        if (obj.hasOwnProperty(k)) {
            var v = obj[k]
            if (_.isString(v)) out[k] = truncate(v, 100)
            else out[k] = v
        }
    }
    return out
}

/// Convenience functions for working with the this.errors
/// object provided by koa-validate

// errObj is the this.errors object from koa-validate
// Maybe Object -> Maybe [String]
export const extractErrors = function(errObj) {
    return (
        errObj &&
        _.chain(errObj)
            .map(_.values)
            .map(function(s) {
                return s.join(', ')
            })
            .value()
    )
}

// Maybe Object -> Maybe String
export const joinErrors = function(errObj) {
    return errObj && extractErrors(errObj).join(', ')
}

////////////////////////////////////////////////////////////
// Authentication
////////////////////////////////////////////////////////////

export const hashPassword = password => {
    return bcrypt.hash(password, 10)
}

// String -> String -> Bool
export const checkPassword = (password, digest) => {
    return bcrypt.compare(password, digest)
}

////////////////////////////////////////////////////////////

// String -> Bool
export const isValidUuid = (() => {
    const re = /^[a-f0-9]{8}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{4}\-[a-f0-9]{12}$/i
    return (uuid) => {
        if (typeof uuid !== 'string') return false
        return re.test(uuid)
    }
})()

////////////////////////////////////////////////////////////

// pageParam comes from the query string (the client). ?page={pageParam}
// The route should ensure that it's a number since routes shouldn't
// let bad input infect the rest of the system. It can also be undefined.
//
// This function is for use in routes to calculate currPage (Int) and
// totalPages (Int) for use in the view-layer's paginate.render macro
// to generate prev/next button for arbitrary collections.
export const calcPager = function(pageParam, perPage, totalItems) {
    assert(_.isNumber(totalItems))
    assert(_.isNumber(perPage))
    pageParam = pageParam || 1
    debug('[calcPager] pageParam: ', pageParam)
    assert(_.isNumber(pageParam))
    var currPage, totalPages

    totalPages = Math.ceil(totalItems / perPage)

    currPage = Math.max(pageParam, 1)
    currPage = Math.min(pageParam, totalPages)

    var result = {
        currPage: currPage,
        totalPages: totalPages,
        offset: Math.max(0, perPage * (currPage - 1)),
        limit: perPage,
    }
    debug('[calcPager] result: ', result)
    return result
}

// Returns a number >= 1
export const calcTotalPostPages = function(totalItems) {
    return Math.max(1, Math.ceil(totalItems / config.POSTS_PER_PAGE))
}

// FIXME: This is a sloppy was to see if an object is a pg client
export const isDBClient = function(obj) {
    var keys = Object.keys(obj)

    return (
        keys.includes('database') &&
        keys.includes('connection') &&
        keys.includes('readyForQuery') &&
        keys.includes('hasExecuted') &&
        keys.includes('queryQueue')
    )
}

export const slugifyUname = function(uname) {
    var slug = uname
        .trim()
        .toLowerCase()
        .replace(/ /g, '-')

    return slug
}

var MAX_SLUG_LENGTH = 80
export const slugify = function(...args: (string | number)[]) {
    // Slugifies one string
    function slugifyString(x: string) {
        return (
            x
                .toString()
                .trim()
                // Remove apostrophes
                .replace(/'/g, '')
                // Hyphenize anything that's not alphanumeric, hyphens, or spaces
                .replace(/[^a-z0-9- ]/gi, '-')
                // Replace spaces with hyphens
                .replace(/ /g, '-')
                // Consolidate consecutive hyphens
                .replace(/-{2,}/g, '-')
                // Remove prefix and suffix hyphens
                .replace(/^[-]+|[-]+$/, '')
                .toLowerCase()
        )
    }


    return slugifyString(
        args
            .map(x => String(x))
            .join('-')
            .slice(0, MAX_SLUG_LENGTH)
    )
}

// Returns Int | null
export const extractId = function(slug) {
    var n = parseInt(slug, 10)
    return _.isNaN(n) ? null : n
}

////////////////////////////////////////////////////////////

// Returns Array of uniq lowecase unames that were quote-mentioned in the string
// A [@Mention] is only extracted if it's not nested inside a quote.
export const extractMentions = function(str, unameToReject) {
    var start = Date.now()
    debug('[extractMentions]')
    var unames: Record<string, boolean> = {}
    var re = /\[(quote)[^\]]*\]|\[(\/quote)\]|\[@([a-z0-9_\- ]+)\]/gi
    var quoteStack: string[] = []

    // Stop matching if we've hit notification limit for the post
    var limitRemaining = config.MENTIONS_PER_POST
    assert(_.isNumber(limitRemaining))

    while (true) {
        var match = re.exec(str)
        if (limitRemaining > 0 && match) {
            // match[1] is undefined or 'quote'
            // match[2] is undefined or '/quote'
            // match[3] is undefined or uname
            if (match[1]) {
                // Open quote
                quoteStack.push('quote')
            } else if (match[2]) {
                // Close quote
                quoteStack.pop()
            } else if (match[3]) {
                // uname
                var uname = match[3].toLowerCase()
                if (
                    quoteStack.length === 0 &&
                    uname !== unameToReject.toLowerCase()
                ) {
                    unames[uname] = true
                    limitRemaining--
                    debug('limitRemaining: %s', limitRemaining)
                }
            }
        } else {
            break
        }
    }

    var ret = Object.keys(unames)

    var diff = Date.now() - start
    debug('[PERF] extractMentions executed in %s ms', diff)

    return ret
}

// Returns array of uniq lowercase unames that were quote-mentioned
// i.e. [quote=@some user]
// Only top-level quote-mentions considered
export const extractQuoteMentions = function(str, unameToReject) {
    var start = Date.now()
    debug('[extractQuoteMentions]')
    var unames: Record<string, boolean> = {}
    var re = /\[(quote)=?@?([a-z0-9_\- ]+)\]|\[(\/quote)\]/gi
    var quoteStack: string[] = []

    // Stop matching if we've hit notification limit for the post
    var limitRemaining = config.MENTIONS_PER_POST
    assert(_.isNumber(limitRemaining))

    while (true) {
        var match = re.exec(str)
        if (limitRemaining > 0 && match) {
            // match[1] is undefined or 'quote'
            // match[2] is undefined or uname
            // match[3] is undefined or /uname
            if (match[2]) {
                // Uname
                var uname = match[2].toLowerCase()
                if (
                    quoteStack.length === 0 &&
                    uname !== unameToReject.toLowerCase()
                ) {
                    unames[uname] = true
                    limitRemaining--
                    debug('limitRemaining: %s', limitRemaining)
                }
            }
            if (match[1]) {
                // Open quote
                quoteStack.push('quote')
            }
            if (match[3]) {
                // Close quote
                quoteStack.pop()
            }
        } else {
            break
        }
    }

    var ret = Object.keys(unames)

    var diff = Date.now() - start
    debug('[PERF] extractMentions executed in %s ms', diff)

    return ret
}

export const frequencies = function(objs, prop) {
    return _.chain(objs)
        .groupBy(prop)
        .toPairs()
        .reduce(function(memo, pair) {
            var key = pair[0]
            var vals = pair[1]
            memo[key] = vals.length
            return memo
        }, {})
        .value()
}

// expandJoinStatus('full') => 'Roleplay is not accepting new players'
export const expandJoinStatus = function(status) {
    switch (status) {
        case 'jump-in':
            return 'Players can join and begin posting IC without GM approval'
        case 'apply':
            return 'Players should apply and get GM approval before posting IC'
        case 'full':
            return 'Roleplay is not accepting new players'
        default:
            return ''
    }
}

export const mapMethod = function mapMethod(items, method) {
    return items.map(function(item) {
        return item[method]()
    })
}

////////////////////////////////////////////////////////////

// Number -> String
//
// Example:
//
//    ordinalize(1) -> '1st'
//    ordinalize(12) -> '12th'
export const ordinalize = function(n) {
    assert(Number.isInteger(n))
    return n.toString() + getOrdinalSuffix(n)
}

export const getOrdinalSuffix = function(n) {
    assert(Number.isInteger(n))
    return Math.floor(n / 10) === 1
        ? 'th'
        : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
}

// TODO: Didn't realize I had this function
// just now when I added Autolinker to BBCode parser output.
// I should reuse this function.
// - bbcode.js (server/client)
// - bbcode_editor.js (client)
// At least keep this all sync'd up.
// TODO: Allow me to pass in `opts` obj that's merge with
// my default opts.
export const autolink = function(text) {
    return Autolinker.link(text, {
        stripPrefix: true,
        newWindow: true,
        truncate: 30,
        email: false,
        phone: false,
        hashtag: false,
    })
}

// String -> String
export const escapeHtml = function(unsafe) {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

// Apparently the Expires date string needs to have hyphens between the dd-mmm-yyyy.
// Koa's underlying cookie library just uses .toUTCString() which does not
// output a string with those hyphens
// - Source: https://github.com/pillarjs/cookies/blob/master/lib/cookies.js
// So instead this function returns an object with a .toUTCString() function
// that returns the patched string since that's the only method the cookies.js
// library calls on the value (Date) you provide to the `expires` key.
//
// Usage:
//
//     this.cookies.set('sessionId', session.id, {
//       expires: belt.cookieDate(belt.futureDate({ years: 1 }))
//     });
//
// Update: Don't think I actually need this. Reverted login back from
// using cookieDate. Will get feedback from user having problems.
//
export function cookieDate(date: Date) {
    var padNum = function(n) {
        return n < 10 ? '0' + n : n
    }

    // var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
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

    var outString =
        '' +
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] +
        ', ' +
        padNum(date.getUTCDate()) +
        '-' +
        months[date.getUTCMonth()] +
        '-' +
        date.getUTCFullYear() +
        ' ' +
        padNum(date.getUTCHours()) +
        ':' +
        padNum(date.getUTCMinutes()) +
        ':' +
        padNum(date.getUTCSeconds()) +
        ' GMT'

    return {
        toUTCString: function() {
            return outString
        },
    }
}

// Pretty-/human- version of each role.
//
// Example:
//
//     presentUserRole('conmod') => 'Contest Mod'
//
export const presentUserRole = function(role) {
    assert(_.isString(role))

    switch (role) {
        case 'conmod':
            return 'Contest Mod'
        case 'mod':
            return 'Moderator'
        case 'smod':
            return 'Co-Admin'
        case 'arenamod':
            return 'Arena Mod'
        case 'pwmod':
            return 'Persistent World Mod'
        default:
            return _.capitalize(role)
    }
}

// Helper function for formatting chat messages for the log.txt
export const formatChatDate = (() => {
    const monthNames = [
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

    return date => {
        return (
            date.getDate() +
            '/' +
            monthNames[date.getMonth()] +
            '/' +
            date
                .getFullYear()
                .toString()
                .slice(2, 4) +
            ' ' +
            _.padStart(date.getHours().toString(), 2, '0') +
            ':' +
            _.padStart(date.getMinutes().toString(), 2, '0')
        )
    }
})()

////////////////////////////////////////////////////////////

export const timeout = function(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export const daysAgo = function(date) {
    return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
}

////////////////////////////////////////////////////////////

// mergeQuery('google.com?foo=bar', { page: 2 }) -> google.com?foo=bar&page=2
// mergeQuery('google.com?foo=bar', { foo: null }) -> google.com
//
// null or undefined values are deleted from query map
export const mergeQuery = function(href, obj) {
    const url = new URL(href)
    Object.keys(obj).forEach(k => {
        if (typeof obj[k] === 'undefined' || obj[k] === null) {
            url.searchParams.delete(k)
        } else {
            url.searchParams.set(k, obj[k])
        }
    })
    return url.href
}

////////////////////////////////////////////////////////////

// Returns true if user has logged in 0-12 hrs ago
export const withinGhostRange = (() => {
    const hours24 = 1000 * 60 * 60 * 24

    return function(lastOnlineAt) {
        // User hasn't loggin in since relaunch
        if (!lastOnlineAt) return false
        assert(lastOnlineAt instanceof Date)
        return Date.now() - lastOnlineAt.getTime() < hours24
    }
})()
