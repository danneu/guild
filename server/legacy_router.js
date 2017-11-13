'use strict'
// Node
// 3rd party
var Router = require('koa-router')
var _ = require('lodash')
var koaSend = require('koa-send')
var debug = require('debug')('app:legacy_router.js')
// 1st party

var router = new Router()

////////////////////////////////////////////////////////////

var uidTable = {
    '2485': '/users/izaka-sazaka',
}

router.get('/member.php', async ctx => {
    const redirectTo = uidTable[ctx.query.u]
    ctx.assert(redirectTo, 404)

    ctx.status = 301
    ctx.redirect(redirectTo)
})

////////////////////////////////////////////////////////////

// For forumdisplay.php?f=xx URLs
const fidTable = {
    // No more "Free OOC" forum
    '18': '/forums/3-free-roleplay',
    '5': '/forums/33-off-topic-discussion',
}

router.get('/forumdisplay.php', async ctx => {
    if (_.keys(ctx.query).includes('15-Casual-OOC')) {
        ctx.status = 301
        ctx.redirect('/forums/4-casual-roleplay')
        return
    }

    if (_.keys(ctx.query).includes('42-Forum-Games-Spam')) {
        ctx.status = 301
        ctx.redirect('/forums/30-spam-forum')
        return
    }

    ctx.validateQuery('f')

    const redirectTo = fidTable[ctx.vals.f]
    ctx.assert(redirectTo, 404)

    ctx.status = 301
    ctx.redirect(redirectTo)
})

////////////////////////////////////////////////////////////

// legacy_html/showthread/:id
const tids = {
    '106673': true,
}

const tidQueries = {
    // showthread.php?139029-Sobetsu-Cloaked-Rancor-OOC
    '139029-Sobetsu-Cloaked-Rancor-OOC': true,
    '130932-Shadows-of-Edin-OOC-always-open': true,
    '34778-The-Burning-Void-(Scifi-Nations-OOC)': true,
    '75300-Flames-on-the-Horizon-A-Traveller-Roleplay': true, // busted assets
    '36262-The-secret-academy-of-Felours(Sci-fi-Action)': true, // busted assets
    '146204-Tumblr-Vs-Photobucket-Vs-imgur': true,
    '11824-Sandcastle-IC': true, // busted assets
    '132676-The-Bandits-of-Skyrim-(OOC)': true, // busted assets
    '133437-Using-Google-Docs-for-RPs': true,
    '186461-Vampire-The-Masquerade-The-Final-Nights-Guide': true, // busted assets
}

router.get('/showthread.php', async ctx => {
    ctx.validateQuery('t')

    let staticPath
    if (tids[ctx.vals.t]) staticPath = ctx.vals.t
    else if (tidQueries[Object.keys(ctx.query)[0]])
        staticPath = Object.keys(ctx.query)[0]

    ctx.assert(staticPath, 404)

    await koaSend(ctx, staticPath + '.html', {
        root: 'legacy_html/showthread',
        maxage: 1000 * 60 * 60 * 24 * 365,
    })
})

////////////////////////////////////////////////////////////

// 301 Redirects
;[
    ['/index.php', '/'],
    ['/members/drakell', '/users/drakel'],
    ['/memberlist.php', '/users'],
    // No more member lounge
    ['/forums/32', '/forums/33-off-topic-discussion'],
    ['/forums/32-member-lounge', '/forums/33-off-topic-discussion'],
    // "Need Help" forum merged
    ['/forums/36', '/forums/9-suggestions-problems'],
    ['/forums/36-need-help', '/forums/9-suggestions-problems'],
    ['/members/gamerdude369', '/users/gamerdude369'],
    ['/f9', '/forums/5-advanced-roleplay'],
    ['/f8/the-morlat-death-march-8', '/f9/the-morlat-death-march-8'],
].forEach(([oldUrl, newUrl]) => {
    router.get(oldUrl, async ctx => {
        ctx.status = 301
        ctx.redirect(newUrl)
    })
})

router.get('member.php', async () => {
    if (_.keys(ctx.query).includes('34089-Komamisa')) {
        ctx.status = 301
        ctx.redirect('/users/komamisa')
        return
    }

    ctx.status = 404
})

// 410 scraper output (also checked the t=_ version of most of these
// /showthread.php?153742
// /showthread.php?154148-OOC-These-Gray-Lands
// /showthread.php?12199-viridium-veridens-ooc
// /showthread.php?124159-Cog-Styx-OOC
// /showthread.php?153448-OB6-A-Fresh-Start-OOC
// /showthread.php?66910-The-Glass-Men-OOC-Open
// /showthread.php?100105-The-Future-Is-Now-OOC
// /showthread.php?43470-Eternal-Recurrence-OOC
// /showthread.php?54898-Kamatayan-OOC
// /showthread.php?40515-Oasis-OOC
// /showthread.php?19079-Everything-is-Quiet-OOC
// /showthread.php?23797-Base-Station-Echo-(OOC)
// /showthread.php?21304-Crusade-Of-The-Beasts-OOC
// /showthread.php?62730-Darkcove-City-OOC-Sign-ups
// /showthread.php?69454-Mechwarrior-Mercenary-Commander-OOC
// /showthread.php?28203-No-Longer-a-Society-Only-a-Hell-OOC
// /showthread.php?21205-Vigilante-8-Century-21-(Sign-Ups-OOC)
// /showthread.php?5253-Back-Alley-2975-(Science-Fiction-RP)-OOC
// /showthread.php?179211-Prison-Break-OOC-(Post-Apocolyptic-Escape)
// /showthread.php?28595-SALVATION-Death-the-Destroyer-of-Worlds-OOC
// /showthread.php?89243-Warfare!-In-the-Space-Colony-of-Tomorrow!-OOC
// /showthread.php?29753-Amongst-the-Stars-Development-and-Combat-Rules
// /f5/unforgotten-realms-refugee-society-20475
// /showthread.php?65468-After-Earth-The-Endless-Night-Chronicles-(Action-Sci-Fi-Horror)-(5-10-Open
// /f44/drageloc-town-called-shorriden-84181/index5.html
// showthread.php?107049-How-much-do-Siege-Engines-weigh
// showthread.php?10025-A-Poem-Insecure-Men-and-the-Women-Who-Love-Them
// f18/supernatural-school-rp-115740
// showthread.php?195351-Harry-Potter-RP-Basic-Plot-Idea
// showthread.php?4549-The-Revolution-OOC
// showthread.php?154293-Who-will-survive!
// f26/good-names-for-rping-72791/index4.html
// f18/aliens-vs-predator-ooc-92613/index3.html
// f15/ooc-whirlwind-of-doom-14970
// f17/another-art-therda-89329
// f27/rai-vs-asperser-61299
// showthread.php?155731-An-essay-on-gender-communication-differences
// showthread.php?5234-Aseric-OOC
// showthread.php?165060-Dragons-Dogma-inspired-Roleplay
// showthread.php?172481-The-Crusades-genocide-or-not
// showthread.php?154059-Instant-Message-Roleplay

////////////////////////////////////////////////////////////

const rehosted = [
    '/f9/mechanical-possession-78',
    '/f7/the-night-wars-3137',
    '/f13/an-indepth-look-of-firearms-2801',
    '/f3/rpguild-re-launched-1',
    '/f15/rift-walkers-ooc-2015',
    '/f9/the-morlat-death-march-8',
    '/f10/fistfight-open-1v1-no-magic-powers-no-weapons-22',
    '/f27/arena-basics-4119',
    '/f13/a-basic-guide-of-weapons-and-fighting-97',
    '/f8/the-wolves-of-the-eternal-mountain-21224',
]

rehosted.forEach(url => {
    router.get(url, async ctx => {
        await koaSend(ctx, ctx.path + '.html', {
            root: 'legacy_html',
            maxage: 1000 * 60 * 60 * 24 * 365,
        })
    })
})

////////////////////////////////////////////////////////////

module.exports = router
