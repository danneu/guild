const assert = require('assert')
const { URL } = require('url')

module.exports = function protectCsrf(hostnameWhitelist) {
    assert(Array.isArray(hostnameWhitelist), 'must provide whitelist array')
    assert(hostnameWhitelist.length > 0, 'must provide at least one hostname')
    assert(
        hostnameWhitelist.every(x => typeof x === 'string'),
        'whitelist must be array of strings'
    )

    const predicate = requestedHostname => {
        return hostnameWhitelist.some(
            whitelisted =>
                requestedHostname === whitelisted ||
                requestedHostname.endsWith('.' + whitelisted)
        )
    }

    return async (ctx, next) => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.request.method)) {
            return next()
        }

        // Unlike the Referer, the Origin header will be present in
        // HTTP requests that originate from an HTTPS URL.
        let origin
        try {
            origin = new URL(ctx.request.headers['origin'])
        } catch (err) {
            if (err.code !== 'ERR_INVALID_URL') {
                throw err
            }
        }

        if (origin && predicate(origin.hostname)) {
            return next()
        }

        let referer
        try {
            referer = new URL(ctx.request.headers['referer'])
        } catch (err) {
            if (err.code !== 'ERR_INVALID_URL') {
                throw err
            }
        }

        if (referer && predicate(referer.hostname)) {
            return next()
        }

        // CSRF measure failed.
        // For now, log the issue instead of rejecting request.
        // console.warn(
        //     `csrf protection triggered for request to ${ctx.request.method} "${
        //         ctx.request.path
        //     }" with headers:\n${JSON.stringify(ctx.request.headers, null, 2)}`
        // )
        // return next()

        ctx.throw(403)
    }
}
