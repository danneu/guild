
const Discord = require("discord.js")
const bot = new Discord.Client()
const config = require('./config')
const dice = require('./dice')

module.exports = { connect () {
  if (!config.IS_DISCORD_CONFIGURED) {
    console.log('Cannot start GuildBot because Discord is not configured')
    return
  }

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
