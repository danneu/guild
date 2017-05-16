'use strict'
// 3rd
const assert = require('better-assert')
const fetch = require('node-fetch')
const debug = require('debug')('app:client:index')
const promiseMap = require('promise.map')
const createError = require('create-error')

const ResponseNotOkError = createError('ResponseNotOkError')

class Client {
  constructor ({botToken, userAgent}) {
    assert(typeof botToken === 'string')
    assert(typeof userAgent === 'string')
    this.botToken = botToken
    // https://discordapp.com/developers/docs/reference#user-agent
    this.userAgent = userAgent
  }

  async request (method, url, {headers: extraHeaders, body}) {
    assert(['GET', 'POST', 'DELETE', 'PUT', 'PATCH'].includes(method))
    assert(typeof url === 'string')

    debug('[Client#request] body=%j', body)

    const headers = Object.assign({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': this.userAgent
    }, extraHeaders)

    const response = await fetch(url, {
      method,
      headers: new fetch.Headers(headers),
      body: JSON.stringify(body)
    })

    const bodyText = await response.text()

    // Not a 2XX response
    if (!response.ok) {
      // FIXME: I still don't know the best way nor when to
      // produce / handle errors in my own javascript APIs...
      throw new ResponseNotOkError(`${response.status} ${response.statusText}`, {
        status: response.status,
        bodyText
      })
    }

    // It is a 2XX response

    try {
      return JSON.parse(bodyText)
    } catch (err) {
      return null
    }
  }

  async botRequest (method, url, body) {
    return this.request(method, url, {
      headers: { Authorization: `Bot ${this.botToken}` },
      body
    })
  }

  async userRequest (token, method, url, body) {
    return this.request(method, url, {
      headers: { Authorization: `Bearer ${token}` },
      body
    })
  }

  async createGuild (body) {
    const url = `https://discordapp.com/api/guilds`
    return this.botRequest('POST', url, body)
  }

  async deleteGuild (id) {
    assert(typeof id === 'string')
    const url = `https://discordapp.com/api/guilds/${id}`
    return this.botRequest('DELETE', url)
  }

  async createRoles (guildId, roles) {
    assert(typeof guildId === 'string')
    assert(Array.isArray(roles))
    const url = `https://discordapp.com/api/guilds/${guildId}/roles`
    return promiseMap(roles, (role) => {
      return this.botRequest('POST', url, role)
    }, 1)
  }

  async listRoles (guildId) {
    assert(typeof guildId === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}/roles`
    return this.botRequest('GET', url)
  }

  async updateRole (guildId, roleId, body) {
    assert(typeof guildId === 'string')
    assert(typeof roleId === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}/roles/${roleId}`
    return this.botRequest('PATCH', url, body)
  }

  async deleteRole (guildId, roleid) {
    assert(typeof guildId === 'string')
    assert(typeof roleId === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}/roles/${roleId}`
    return this.botRequest('DELETE', url)
  }

  async getGuild (guildId) {
    assert(typeof guildId === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}`
    return this.botRequest('GET', url)
  }

  // Widget must be enabled
  async getGuildEmbed (guildId) {
    assert(typeof guildId === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}/embed.json`
    return this.botRequest('GET', url)
  }

  async getUser (token) {
    assert(typeof token === 'string')
    const url = 'https://discordapp.com/api/users/@me'
    return this.userRequest(token, 'GET', url)
  }

  async getBot () {
    const url = 'https://discordapp.com/api/users/@me'
    return this.botRequest('GET', url)
  }

  async updateBot (body) {
    const url = 'https://discordapp.com/api/users/@me'
    return this.botRequest('PATCH', url, body)
  }

  // Returns member object or null if userId not found
  async getGuildMember (guildId, userId) {
    assert(typeof guildId === 'string')
    assert(typeof userId === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}/members/${userId}`
    return this.botRequest('GET', url)
      .catch((err) => {
        // TODO: This shouldn't fire on all 404, just when API has no results
        if (err instanceof ResponseNotOkError && err.status === 404) {
          return null
        }
        throw err
      })
  }

  // Returns no body
  async modifyGuildMember (guildId, userId, body) {
    assert(typeof guildId === 'string')
    assert(typeof userId === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}/members/${userId}`
    return this.botRequest('PATCH', url, body)
  }

  async addGuildMember (guildId, userId, body) {
    assert(typeof guildId === 'string')
    assert(typeof userId === 'string')
    assert(typeof body.access_token === 'string')
    const url = `https://discordapp.com/api/guilds/${guildId}/members/${userId}`
    return this.botRequest('PUT', url, body)
  }
}

module.exports = Client
