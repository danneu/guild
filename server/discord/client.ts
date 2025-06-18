import assert from "assert";
import type {
  APIGuild,
  APIGuildMember,
  APIRole,
  APIChannel,
  APIUser,
  APIMessage,
  RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIGuildRoleJSONBody,
  RESTPatchAPIGuildJSONBody,
  RESTPatchAPIGuildMemberJSONBody,
  RESTPutAPIGuildMemberJSONBody,
  RESTGetAPIGuildMembersQuery,
  APIApplication,
  RESTPostAPIGuildsJSONBody,
  RESTPatchAPIGuildRoleJSONBody,
  RESTPatchAPICurrentUserJSONBody,
} from "discord-api-types/v10";

class ResponseNotOkError extends Error {
  status: number;
  bodyText: string;
  constructor(message: string, details: { status: number; bodyText: string }) {
    super(message);
    this.name = "ResponseNotOkError";
    this.status = details.status;
    this.bodyText = details.bodyText;
    Error.captureStackTrace(this, this.constructor);
  }
}

type RequestOptions = {
  headers?: Record<string, string>;
  body?: any;
};

export default class Client {
  private botToken: string;
  private userAgent: string;
  private apiVersion: number;
  private baseUrl: string;

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
    this.userAgent = userAgent;
    this.apiVersion = 10;
    this.baseUrl = `https://discord.com/api/v${this.apiVersion}`;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    { headers: extraHeaders = {}, body }: RequestOptions = {},
  ): Promise<T> {
    assert(["GET", "POST", "DELETE", "PUT", "PATCH"].includes(method));
    assert(typeof path === "string");
    assert(path.startsWith("/"));

    const url = this.baseUrl + path;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...extraHeaders,
    };

    const requestOptions: RequestInit = {
      method,
      headers,
    };

    if (body) {
      requestOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, requestOptions);

    const bodyText = await response.text();

    if (!response.ok) {
      throw new ResponseNotOkError(
        `${response.status} ${response.statusText} ${bodyText}`,
        {
          status: response.status,
          bodyText,
        },
      );
    }

    try {
      return JSON.parse(bodyText) as T;
    } catch (err) {
      return null as T;
    }
  }

  private async botRequest<T = unknown>(
    method: string,
    url: string,
    body?: any,
  ): Promise<T> {
    return this.request<T>(method, url, {
      headers: { Authorization: `Bot ${this.botToken}` },
      body,
    });
  }

  private async userRequest<T = unknown>(
    token: string,
    method: string,
    url: string,
    body?: any,
  ): Promise<T> {
    return this.request<T>(method, url, {
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
  }

  // Guild methods
  async createGuild(body: RESTPostAPIGuildsJSONBody): Promise<APIGuild> {
    return this.botRequest<APIGuild>("POST", "/guilds", body);
  }

  async deleteGuild(id: string): Promise<void> {
    assert(typeof id === "string");
    const url = `/guilds/${id}`;
    return this.botRequest<void>("DELETE", url);
  }

  async modifyGuild(
    id: string,
    body: RESTPatchAPIGuildJSONBody,
  ): Promise<APIGuild> {
    assert(typeof id === "string");
    const url = `/guilds/${id}`;
    return this.botRequest<APIGuild>("PATCH", url, body);
  }

  async getGuild(guildId: string): Promise<APIGuild> {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}`;
    return this.botRequest<APIGuild>("GET", url);
  }

  // Role methods
  async createRole(
    guildId: string,
    body: RESTPostAPIGuildRoleJSONBody,
  ): Promise<APIRole> {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/roles`;
    return this.botRequest<APIRole>("POST", url, body);
  }

  async listRoles(guildId: string): Promise<APIRole[]> {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/roles`;
    return this.botRequest<APIRole[]>("GET", url);
  }

  async updateRole(
    guildId: string,
    roleId: string,
    body: RESTPatchAPIGuildRoleJSONBody,
  ): Promise<APIRole> {
    assert(typeof guildId === "string");
    assert(typeof roleId === "string");
    const url = `/guilds/${guildId}/roles/${roleId}`;
    return this.botRequest<APIRole>("PATCH", url, body);
  }

  async deleteRole(guildId: string, roleId: string): Promise<void> {
    assert(typeof guildId === "string");
    assert(typeof roleId === "string");
    const url = `/guilds/${guildId}/roles/${roleId}`;
    return this.botRequest<void>("DELETE", url);
  }

  // Member methods
  async listGuildMembers(
    guildId: string,
    query?: RESTGetAPIGuildMembersQuery,
  ): Promise<APIGuildMember[]> {
    assert(typeof guildId === "string");
    const params = new URLSearchParams({
      limit: "1000",
      ...query,
    } as any);
    const url = `/guilds/${guildId}/members?${params}`;
    return this.botRequest<APIGuildMember[]>("GET", url);
  }

  async getGuildMember(
    guildId: string,
    userId: string,
  ): Promise<APIGuildMember | null> {
    assert(typeof guildId === "string");
    assert(typeof userId === "string");
    const url = `/guilds/${guildId}/members/${userId}`;
    return this.botRequest<APIGuildMember>("GET", url).catch((err) => {
      if (err instanceof ResponseNotOkError && err.status === 404) {
        return null;
      }
      throw err;
    });
  }

  async modifyGuildMember(
    guildId: string,
    userId: string,
    body: RESTPatchAPIGuildMemberJSONBody,
  ): Promise<APIGuildMember> {
    assert(typeof guildId === "string");
    assert(typeof userId === "string");
    const url = `/guilds/${guildId}/members/${userId}`;
    return this.botRequest<APIGuildMember>("PATCH", url, body);
  }

  async addGuildMember(
    guildId: string,
    userId: string,
    body: RESTPutAPIGuildMemberJSONBody,
  ): Promise<APIGuildMember | void> {
    assert(typeof guildId === "string");
    assert(typeof userId === "string");
    assert(typeof body.access_token === "string");
    const url = `/guilds/${guildId}/members/${userId}`;
    return this.botRequest<APIGuildMember>("PUT", url, body);
  }

  // Channel methods
  async listGuildChannels(guildId: string): Promise<APIChannel[]> {
    assert(typeof guildId === "string");
    const url = `/guilds/${guildId}/channels`;
    return this.botRequest<APIChannel[]>("GET", url);
  }

  async getChannel(channelId: string): Promise<APIChannel> {
    assert(typeof channelId === "string");
    const url = `/channels/${channelId}`;
    return this.botRequest<APIChannel>("GET", url);
  }

  async createMessage(
    channelId: string,
    body: RESTPostAPIChannelMessageJSONBody,
  ): Promise<APIMessage> {
    assert(typeof channelId === "string");
    const url = `/channels/${channelId}/messages`;
    return this.botRequest<APIMessage>("POST", url, body);
  }

  // User methods
  async getUser(token: string): Promise<APIUser> {
    assert(typeof token === "string");
    const url = "/users/@me";
    return this.userRequest<APIUser>(token, "GET", url);
  }

  async getBot(): Promise<APIUser> {
    const url = "/users/@me";
    return this.botRequest<APIUser>("GET", url);
  }

  async updateBot(body: RESTPatchAPICurrentUserJSONBody): Promise<APIUser> {
    const url = "/users/@me";
    return this.botRequest<APIUser>("PATCH", url, body);
  }

  // OAuth2
  async getBotApplication(): Promise<APIApplication> {
    const url = `/oauth2/applications/@me`;
    return this.botRequest<APIApplication>("GET", url);
  }
}
