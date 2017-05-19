
// 3rd
const Discord = require('discord.js')
const {sql} = require('pg-extra')
// 1st
const config = require('./config')
const dice = require('./dice')
const {getClient} = require('./db/util')

module.exports = { async connect () {
  if (!config.IS_DISCORD_CONFIGURED) {
    console.log('Cannot start GuildBot because Discord is not configured')
    return
  }

  // Ensure only one bot is running

  const client = getClient()
  client.connect()

  const {lock} = await client.one(sql`SELECT pg_try_advisory_lock(1337) "lock"`)

  if (!lock) {
    // Release the losing clients
    client.end()
    return
  }

  const bot = new Discord.Client()

  bot.on('ready', () => {
    console.log(`Logged in as ${bot.user.username}!`)
  })

  bot.on('message', (msg) => {
    if (msg.content === '!ping') {
      msg.reply('pong')
      return
    }

    if (msg.content.startsWith('!roll ')) {
      const [_, syntax] = msg.content.split(/\s+/)
      if (syntax.length === 0) return

      let output
      try {
        output = dice.roll(syntax)
      } catch (err) {
        msg.reply(`Error: ${err}`)
        return
      }

      const rollValues = [].concat.apply([], output.rolls.map((r) => r.values))

      if (rollValues.length > 1) {
        msg.reply(`:game_die: ${syntax} → ${JSON.stringify(rollValues)} → \`${output.total}\``)
      } else {
        msg.reply(`:game_die: ${syntax} → \`${output.total}\``)
      }
      return
    }
  })

  bot.login(config.DISCORD_BOT_TOKEN)
}}
