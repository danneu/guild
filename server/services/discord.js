
// 3rd
const debug = require('debug')('app:services:discord')
// 1st
const Client = require('../discord/client')
const config = require('../config')
const pre = require('../presenters')

////////////////////////////////////////////////////////////

function makeClient () {
  return new Client({botToken: config.DISCORD_BOT_TOKEN})
}

////////////////////////////////////////////////////////////

exports.broadcastUserJoin = async (user) => {
  // Need url
  pre.presentUser(user)

  if (!config.IS_DISCORD_CONFIGURED) {
    console.error(`
      Called services.discord.js#broadcastUserJoin but Discord
      is not configured.
    `)
    return
  }

  const client = makeClient()

  // Find the #staff-only channel
  const channel = await client.listGuildChannels(config.DISCORD_GUILD_ID)
    .then((cs) => cs.find((c) => c.name === 'staff-only'))

  if (!channel) {
    console.error(`
      Could not find a #staff-only channel for broadcast.
    `)
    return
  }

  // Broadcast
  await client.createMessage(channel.id, {
    content: `A new user joined: ${config.HOST}${user.url}`
  })
}
