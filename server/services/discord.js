
// 3rd
const debug = require('debug')('app:services:discord')
const assert = require('better-assert')
// 1st
const Client = require('../discord/client')
const config = require('../config')
const pre = require('../presenters')

//
// TODO: DRY up these functions.
// TODO: Avoid the #staff-channel lookup on every function call.
//

////////////////////////////////////////////////////////////

function makeClient () {
  return new Client({botToken: config.DISCORD_BOT_TOKEN})
}

////////////////////////////////////////////////////////////

// nuker and spambot are users
exports.broadcastManualNuke = async ({nuker, spambot}) => {
  assert(nuker)
  assert(spambot)
  pre.presentUser(nuker)
  pre.presentUser(spambot)

  const client = makeClient()

  // Find the #staff-only channel
  const channel = await client.listGuildChannels(config.DISCORD_GUILD_ID)
    .then((cs) => cs.find((c) => c.name === 'staff-only'))

  if (!channel) {
    console.error(`Could not find a #staff-only channel for broadcast.`)
    return
  }

  const content = `@here :hammer: **${nuker.uname}** nuked ${config.HOST}${spambot.url} :radioactive:`

  console.log(content)

  // Broadcast
  await client.createMessage(channel.id, { content })
}

////////////////////////////////////////////////////////////

// nuker and spambot are users
exports.broadcastManualUnnuke = async ({nuker, spambot}) => {
  assert(nuker)
  assert(spambot)
  pre.presentUser(nuker)
  pre.presentUser(spambot)

  const client = makeClient()

  // Find the #staff-only channel
  const channel = await client.listGuildChannels(config.DISCORD_GUILD_ID)
    .then((cs) => cs.find((c) => c.name === 'staff-only'))

  if (!channel) {
    console.error(`Could not find a #staff-only channel for broadcast.`)
    return
  }

  const content = `@here :white_check_mark: **${nuker.uname}** UN-nuked ${config.HOST}${spambot.url}`

  // Broadcast
  await client.createMessage(channel.id, { content })
}

////////////////////////////////////////////////////////////

// Info is an object of arbitrary data about the analysis
// to be sent along with the broadcast for debugging purposes.
exports.broadcastAutoNuke = async (user, postId, info) => {
  assert(user)
  assert(Number.isInteger(postId))

  // Need url
  pre.presentUser(user)

  if (!config.IS_DISCORD_CONFIGURED) {
    console.error(`
      Called services.discord.js#broadcastAutoNuke but Discord
      is not configured.
    `)
    return
  }

  const client = makeClient()

  // Find the #staff-only channel
  const channel = await client.listGuildChannels(config.DISCORD_GUILD_ID)
    .then((cs) => cs.find((c) => c.name === 'staff-only'))

  if (!channel) {
    console.error(`Could not find a #staff-only channel for broadcast.`)
    return
  }

  const content = `@here :robot: User ${config.HOST}${user.url} was auto-nuked for this post: ${config.HOST}/posts/${postId} :radioactive:

\`\`\`
${JSON.stringify(info, null, 2)}
\`\`\`
  `.trim()

  // Broadcast
  await client.createMessage(channel.id, { content })
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
    console.error(`Could not find a #staff-only channel for broadcast.`)
    return
  }

  // Broadcast
  await client.createMessage(channel.id, {
    content: `@here :baby: A new user joined: ${config.HOST}${user.url}`
  })
}

////////////////////////////////////////////////////////////

exports.broadcastIntroTopic = async (user, topic) => {
  // Need url
  pre.presentUser(user)
  pre.presentTopic(topic)

  const client = makeClient()

  const channel = await client.listGuildChannels(config.DISCORD_GUILD_ID)
    .then((cs) => cs.find((c) => c.name === 'general'))

  if (!channel) {
    console.error(`Could not find a #general channel for broadcast.`)
    return
  }

  // Broadcast
  await client.createMessage(channel.id, {
    content: `Howdy, :wave: **${user.uname}** created an Introduce Yourself thread: ${config.HOST}${topic.url}. Please help us welcome them!`
  })
}
