'use strict'
// 3rd
const Router = require('koa-router')
const SimpleOauth2 = require('simple-oauth2')
const uuid = require('uuid')
const debug = require('debug')('app:routes:discord')
const assert = require('better-assert')
// 1st
const config = require('../config')
const DiscordClient = require('../discord/client')

////////////////////////////////////////////////////////////

const router = new Router()

router.use(async (ctx, next) => {
  // Ensure Discord is configured
  ctx.assert(config.IS_DISCORD_CONFIGURED, 404, 'Discord is not configured')

  // Ensure user exists and is not banned
  ctx.assert(ctx.currUser, 404, 'You must be logged in to join the Discord server')
  ctx.assert(ctx.currUser.role !== 'banned', 404, 'You are banned')

  return next()
})

////////////////////////////////////////////////////////////

const oauth2 = SimpleOauth2.create({
  client: {
    id: config.DISCORD_APP_CLIENTID,
    secret: config.DISCORD_APP_CLIENTSECRET
  },
  auth: {
    tokenHost: 'https://discordapp.com',
    tokenPath: '/api/oauth2/token',
    authorizePath: '/api/oauth2/authorize'
  }
})

const redirect_uri = config.NODE_ENV === 'production'
  ? 'https://www.roleplayerguild.com/discord/callback'
  : 'http://localhost:3000/discord/callback'

const discord = new DiscordClient({
  botToken: config.DISCORD_BOT_TOKEN,
  userAgent: 'GuildBot (roleplayerguild.com, 0.0.1)'
})

////////////////////////////////////////////////////////////

router.get('/discord', async (ctx) => {
  const state = uuid.v4()
  const authzUri = oauth2.authorizationCode.authorizeURL({
    redirect_uri,
    state,
    scope: ['identify', 'guilds.join'].join(' ')
  })

  ctx.cookies.set('oauth2_state', state)
  ctx.redirect(authzUri)
})

////////////////////////////////////////////////////////////

// FIXME: Race conditions
router.get('/discord/callback', async (ctx) => {
  if (ctx.query.error) {
    ctx.body = `
      Error received from Discord API: ${ctx.query.error}
    `
    return
  }

  if (ctx.query.state !== ctx.cookies.get('oauth2_state')) {
    ctx.body = `
      Error: OAuth state mismatch
    `
    return
  }

  // Get code that Discord sent us via redirect params
  const {code} = ctx.query
  ctx.assert(code, 400, 'Expected code in OAuth redirect')

  // tokenInfo looks like { access_token, expires_in, ...}
  const {token: {access_token: accessToken}} = await oauth2.authorizationCode.getToken({
    code, redirect_uri
  }).then((result) => {
    return oauth2.accessToken.create(result)
  })

  ctx.cookies.set('oauth2_token', accessToken)

  // roleMap is a mapping of name -> id
  // { @everyone: _, Admin: _, Staff: _, Member: _ }
  const roleMap = await discord.listRoles(config.DISCORD_GUILD_ID)
    .then((roles) => {
      const mapping = {}
      roles.forEach((role) => { mapping[role.name] = role.id })
      return mapping
    })

  let roles = []
  if (['smod', 'admin'].includes(ctx.currUser.role)) {
    roles = [roleMap['Admin'], roleMap['Staff']]
  } else if (['conmod', 'arenamod', 'mod'].includes(ctx.currUser.role)) {
    roles = [roleMap['Staff']]
  } else if (ctx.currUser.role === 'member') {
    roles = [roleMap['Member']]
  }

  const discordUser = await discord.getUser(accessToken)
  let guildMember = await discord.getGuildMember(config.DISCORD_GUILD_ID, discordUser.id)
  if (guildMember) {
    guildMember = await discord.modifyGuildMember(config.DISCORD_GUILD_ID, discordUser.id, {
      nick: ctx.currUser.uname,
      roles
    })
  } else {
    guildMember = await discord.addGuildMember(config.DISCORD_GUILD_ID, discordUser.id, {
      access_token: accessToken,
      nick: ctx.currUser.uname,
      roles
    })
  }

  debug('discord guildMember', guildMember)

  ctx.redirect('https://discordapp.com/channels/@me')
})

////////////////////////////////////////////////////////////

module.exports = router
