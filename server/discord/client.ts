import assert from "assert";

class ResponseNotOkError extends Error {
  status: number;
  bodyText: string;
  constructor(message: string, details: { status: number; bodyText: string }) {
    super(message);
    this.name = "ResponseNotOkError";
    this.status = details.status;
    this.bodyText = details.bodyText;
    // Capture stack trace, excluding the constructor call from it
    Error.captureStackTrace(this, this.constructor);
  }
}

export default class Client {
  botToken: string;
  userAgent: string;
  apiVersion: number;
  baseUrl: string;

  constructor({
    botToken,
    userAgent = "GuildBot (roleplayerguild.com, 0.0.1)",
  }: {
    botToken: string;
    userAgent?: string;
  }) {
    assert(typeof botToken === "string");
    assert(typeof userAgent === "string");
    this.botToken = botToken;
    // https://discordapp.com/developers/docs/reference#user-agent
    this.userAgent = userAgent;
    // https://discord.com/developers/docs/reference#api-versioning
    this.apiVersion = 10;
    this.baseUrl = `https://discord.com/api/v${this.apiVersion}`;
  }

  async request(
    method: string,
    path: string,
    {
      headers: extraHeaders,
      body,
    }: { headers: Record<string, string>; body: any },
  ) {
    assert(["GET", "POST", "DELETE", "PUT", "PATCH"].includes(method));
    assert(typeof path === "string");
    assert(path.startsWith("/"));

    const url = this.baseUrl + path;

    const headers = Object.assign(
      {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
      extraHeaders,
    );

    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
    });

    const bodyText = await response.text();

    // Not a 2XX response
    if (!response.ok) {
      // FIXME: I still don't know the best way nor when to
      // produce / handle errors in my own javascript APIs...
      throw new ResponseNotOkError(
        `${response.status} ${response.statusText} ${bodyText}`,
        {
          status: response.status,
          bodyText,
        },
      );
    }

    // It is a 2XX response

    try {
      return JSON.parse(bodyText);
    } catch (err) {
      return null;
    }
  }

  async botRequest(
    method: string,
    url: string,
    body: any | undefined = undefined,
  ) {
    return this.request(method, url, {
      headers: { Authorization: `Bot ${this.botToken}` },
      body,
    });
  }

  async userRequest(
    token: string,
    method: string,
    url: string,
    body: any | undefined = undefined,
  ) {
    return this.request(method, url, {
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
  }

  async createGuild(body) {
    return this.botRequest("POST", "/guilds", body);
  }

  async deleteGuild(id) {
    assert(typeof id === "string");
    const url = `/guilds/${id}`;
    return this.botRequest("DELETE", url);
  }

  async modifyGuild(id, body) {
    assert(typeof id === "string");
    const url = `/guilds/${id}`;
    return this.botRequest("PATCH", url, body);
  }

  async createRoles(guildId, roles) {
    assert(typeof guildId === "string");
    assert(Array.isArray(roles));
    const url = `/guilds/${guildId}/roles`;
    for (const role of roles) {
      await this.botRequest("POST", url, role);
    }
  }

  async listRoles(guildId) {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/roles`;
    // return this.botRequest('GET', url)
    return this.botRequest("GET", url);
  }

  async updateRole(guildId, roleId, body) {
    assert(typeof guildId === "string");
    assert(typeof roleId === "string");
    const url = `/guilds/${guildId}/roles/${roleId}`;
    return this.botRequest("PATCH", url, body);
  }

  async deleteRole(guildId, roleId) {
    assert(typeof guildId === "string");
    assert(typeof roleId === "string");
    const url = `/guilds/${guildId}/roles/${roleId}`;
    return this.botRequest("DELETE", url);
  }

  async getGuild(guildId) {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}`;
    return this.botRequest("GET", url);
  }

  // Widget must be enabled
  async getGuildEmbed(guildId) {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/widget.json`;
    return this.botRequest("GET", url);
  }

  async getUser(token) {
    assert(typeof token === "string");
    const url = "/users/@me";
    return this.userRequest(token, "GET", url);
  }

  async getBot() {
    const url = "/users/@me";
    return this.botRequest("GET", url);
  }

  async updateBot(body) {
    const url = "/users/@me";
    return this.botRequest("PATCH", url, body);
  }

  async listGuildMembers(guildId) {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/members?limit=1000`;
    return this.botRequest("GET", url);
  }

  // Returns member object or null if userId not found
  async getGuildMember(guildId, userId) {
    assert(typeof guildId === "string");
    assert(typeof userId === "string");
    const url = `/guilds/${guildId}/members/${userId}`;
    return this.botRequest("GET", url).catch((err) => {
      if (err instanceof ResponseNotOkError && err.status === 404) {
        return null;
      }
      throw err;
    });
  }

  // Returns no body
  async modifyGuildMember(guildId, userId, body) {
    assert(typeof guildId === "string");
    assert(typeof userId === "string");
    const url = `/guilds/${guildId}/members/${userId}`;
    return this.botRequest("PATCH", url, body);
  }

  async addGuildMember(guildId, userId, body) {
    assert(typeof guildId === "string");
    assert(typeof userId === "string");
    assert(typeof body.access_token === "string");
    const url = `/guilds/${guildId}/members/${userId}`;
    return this.botRequest("PUT", url, body);
  }

  async listGuildChannels(guildId) {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/channels`;
    return this.botRequest("GET", url);
  }

  async listGuildBans(guildId) {
    assert(typeof guildId === "string");
    const url = `/api/guilds/${guildId}/bans`;
    return this.botRequest("GET", url);
  }

  //
  // CHANNELS
  //

  async createMessage(channelId, body) {
    assert(typeof channelId === "string");
    const url = `/channels/${channelId}/messages`;
    return this.botRequest("POST", url, body);
  }

  async getChannel(channelId) {
    assert(typeof channelId === "string");
    const url = `/channels/${channelId}`;
    return this.botRequest("GET", url);
  }

  async listChannels(guildId) {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/channels`;
    return this.botRequest("GET", url);
  }

  //
  // OAUTH2
  //

  // https://discordapp.com/developers/docs/topics/oauth2#get-current-application-information
  async getBotApplication() {
    const url = `/oauth2/applications/@me`;
    return this.botRequest("GET", url);
  }
}
