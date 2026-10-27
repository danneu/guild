import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";

import Koa, { Context } from "koa";
import Router from "@koa/router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sendJson } from "./api_json";
import { responseEdge } from "./middleware/response-edge";

////////////////////////////////////////////////////////////
// The staff user lookup view

const registrationIp = "203.0.113.42";

function user(props: Record<string, unknown> = {}) {
  return {
    id: 1,
    uname: "User",
    slug: "user",
    role: "member",
    email: "user@example.test",
    digest: "secret",
    eflags: 123,
    created_at: new Date("2026-07-04T00:00:00Z"),
    last_online_at: new Date("2026-07-05T00:00:00Z"),
    avatar_url: "https://example.test/avatar.png",
    custom_title: "Custom",
    posts_count: 12,
    is_nuked: false,
    registration_ip: registrationIp,
    ...props,
  } as any;
}

// The body sendJson builds for the lookup, with viewer as ctx.currUser.
function staffUser(target: unknown, viewer: unknown) {
  const ctx = { currUser: viewer } as any;
  sendJson(ctx, "staffUser", target as any);
  return ctx.body;
}

describe("the staffUser view", () => {
  it("returns only whitelisted user fields", () => {
    const presented = staffUser(user(), user({ id: 2, role: "admin" }));

    expect(presented).toEqual({
      id: 1,
      uname: "User",
      slug: "user",
      role: "member",
      url: "/users/user",
      created_at: new Date("2026-07-04T00:00:00Z"),
      last_online_at: new Date("2026-07-05T00:00:00Z"),
      avatar_url: "https://example.test/avatar.png",
      custom_title: "Custom",
      posts_count: 12,
      is_nuked: false,
      registration_ip: registrationIp,
      registration_ip_category: null,
    });
  });

  it("gates registration IP visibility by viewer and milestone", () => {
    expect(
      staffUser(user(), user({ id: 2, role: "admin" })).registration_ip,
    ).toBe(registrationIp);
    expect(
      staffUser(user(), user({ id: 2, role: "member" })).registration_ip,
    ).toBeNull();
    expect(
      staffUser(
        user({ created_at: new Date("2026-07-03T23:59:59Z") }),
        user({ id: 2, role: "admin" }),
      ).registration_ip,
    ).toBeNull();
  });

  it("annotates a Cloudflare egress IP for staff", () => {
    const presented = staffUser(
      user({ registration_ip: "104.28.203.54" }),
      user({ id: 2, role: "admin" }),
    );
    expect(presented.registration_ip).toBe("104.28.203.54");
    expect(presented.registration_ip_category).toBe("cloudflare_egress");
  });

  it("hides the note whenever the IP is hidden", () => {
    // Member viewer: IP gated off, so the note must be null too.
    const forMember = staffUser(
      user({ registration_ip: "104.28.203.54" }),
      user({ id: 2, role: "member" }),
    );
    expect(forMember.registration_ip).toBeNull();
    expect(forMember.registration_ip_category).toBeNull();

    // Pre-milestone user: IP gated off, note null.
    const preMilestone = staffUser(
      user({
        registration_ip: "104.28.203.54",
        created_at: new Date("2026-07-03T23:59:59Z"),
      }),
      user({ id: 2, role: "admin" }),
    );
    expect(preMilestone.registration_ip).toBeNull();
    expect(preMilestone.registration_ip_category).toBeNull();
  });
});

////////////////////////////////////////////////////////////
// The response edge
//
// Intent: a body Koa would JSON-encode leaves only if sendJson built it; every
// other kind of body passes the edge unchanged.
// Why it exists: handlers sent raw db rows as JSON, password digests and IPs
// included (finding 261026-0911-025). An object body skips the source sweep
// below, so the edge is what stops the next one.

const MARKUP = "<img src=x onerror=alert(1)>";

class Row {
  ip_address = "198.51.100.4";
}

const shapes = new Router();
shapes.get("/send-json", (ctx: Context) => {
  const row = { id: 1, html: MARKUP, ip_address: "198.51.100.4" };
  sendJson(ctx, "postEdit", row);
});
shapes.get("/rating-duplicate", (ctx: Context) => {
  sendJson(ctx, "rating", undefined);
});
shapes.get("/object", (ctx: Context) => {
  ctx.body = { ip_address: "198.51.100.4" };
});
shapes.get("/array", (ctx: Context) => {
  ctx.body = [{ ip_address: "198.51.100.4" }];
});
shapes.get("/class-instance", (ctx: Context) => {
  ctx.body = new Row();
});
shapes.get("/number", (ctx: Context) => {
  ctx.body = 5;
});
shapes.get("/null", (ctx: Context) => {
  ctx.body = null;
});
shapes.get("/string", (ctx: Context) => {
  ctx.body = "plain";
});
shapes.get("/buffer", (ctx: Context) => {
  ctx.body = Buffer.from("bytes");
});
shapes.get("/stream", (ctx: Context) => {
  ctx.body = Readable.from(["streamed"]);
});
// Not a Stream, but it passes koa's lib/is-stream.js, so Koa pipes it.
shapes.get("/stream-like", (ctx: Context) => {
  const inner = Readable.from(["streamed"]);
  ctx.body = {
    readable: true,
    readableObjectMode: false,
    get destroyed() {
      return inner.destroyed;
    },
    pipe: (dest: NodeJS.WritableStream) => inner.pipe(dest),
    read: () => inner.read(),
    destroy: () => inner.destroy(),
    once: (event: string, fn: (...args: unknown[]) => void) =>
      inner.once(event, fn),
  };
});

const errors: string[] = [];
const app = new Koa();
// Listening replaces Koa's default logger, so a refused body logs nothing.
app.on("error", (err: Error) => errors.push(err.message));
app.use(responseEdge());
app.use(shapes.routes());

const server = http.createServer(app.callback());
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the response edge", () => {
  it("sends a sendJson body as JSON with only the view's fields", async () => {
    const res = await fetch(origin + "/send-json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await res.json()).toEqual({ id: 1, html: MARKUP });
  });

  it("sends a view with nothing to send as JSON null", async () => {
    const res = await fetch(origin + "/rating-duplicate");
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(await res.text()).toBe("null");
  });

  it.each([
    ["a plain object", "/object", "Object"],
    ["an array", "/array", "Array"],
    ["a class instance", "/class-instance", "Row"],
    ["a number", "/number", "number"],
  ])(
    "answers 500 for %s that sendJson did not build",
    async (_l, path, kind) => {
      errors.length = 0;
      const res = await fetch(origin + path);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Server Error");
      expect(errors).toEqual([
        expect.stringContaining(`GET ${path} set a ${kind} body`),
      ]);
    },
  );

  it.each([
    ["no body", "/null", 204, ""],
    ["a string", "/string", 200, "plain"],
    ["a Buffer", "/buffer", 200, "bytes"],
    ["a stream", "/stream", 200, "streamed"],
    ["a stream-like object", "/stream-like", 200, "streamed"],
  ])("lets %s through unchanged", async (_l, path, status, text) => {
    const res = await fetch(origin + path);
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(text);
  });
});

////////////////////////////////////////////////////////////
// The JSON writer sweep
//
// Intent: no server source outside server/api_json.ts writes a JSON body by
// hand. Why it exists: the bio route sent JSON.stringify(row) as an untyped
// string, which the response edge cannot tell from any other text.

const JSON_WRITES = [
  // A body stringified by hand
  /\bctx\.(?:response\.)?body\s*=\s*JSON\.stringify\s*\(/g,
  // A JSON type set by hand, in any quote style
  /\bctx\.(?:response\.)?type\s*=\s*(["'`])[^"'`]*\bjson\b[^"'`]*\1/gi,
];

function jsonWrites(source: string): string[] {
  return JSON_WRITES.flatMap((re) =>
    Array.from(source.matchAll(re), (m) => m[0]),
  );
}

describe("jsonWrites", () => {
  it.each([
    "ctx.body = JSON.stringify(row);",
    "ctx.body =\n    JSON.stringify(row);",
    "return (ctx.body = JSON.stringify(row));",
    "ctx.response.body = JSON.stringify(row);",
    'ctx.type = "json";',
    "ctx.type = 'application/json';",
    'ctx.response.type = "application/json; charset=utf-8";',
    'ctx.type =\n  "json";',
  ])("finds %j", (source) => {
    expect(jsonWrites(source)).toHaveLength(1);
  });

  it.each([
    "if (ctx.body === JSON.stringify(row)) {}",
    "requestOptions.body = JSON.stringify(body);",
    "ctx.body = rating;",
    'ctx.type = "html";',
    'headers: { "Content-Type": "application/json" },',
    'json: (s) => JSON.stringify(s, null, "  "),',
    "const encoded = encodeURIComponent(JSON.stringify(val));",
  ])("ignores %j", (source) => {
    expect(jsonWrites(source)).toEqual([]);
  });
});

describe("server sources", () => {
  it("write no JSON body outside server/api_json.ts", () => {
    const root = join(__dirname, "..");
    const files = execFileSync("git", ["ls-files", "-z", "--", "server"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter((f) => /\.(ts|js)$/.test(f))
      .filter((f) => !f.endsWith(".test.ts") && f !== "server/api_json.ts");
    expect(files).toContain("server/index.ts");

    const hits = files.flatMap((f) =>
      jsonWrites(readFileSync(join(root, f), "utf8")).map((m) => `${f}: ${m}`),
    );
    expect(hits).toEqual([]);
  });
});
