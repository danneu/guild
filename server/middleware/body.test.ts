import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context } from "koa";
import { describe, expect, it } from "vitest";

import { bodyParser } from "./body";

type Seen = { body: unknown; files: unknown; raw: string };

// Runs the real app-wide parser on a bare Koa app. The handler reports what
// the parser left on ctx and then reads whatever is left of the raw stream.
async function send(init: RequestInit): Promise<Seen> {
  let seen: Seen | undefined;
  const app = new Koa();
  app.silent = true;
  app.use(bodyParser());
  app.use(async (ctx: Context) => {
    const { body, files } = ctx.request as { body?: unknown; files?: unknown };
    let raw = "";
    for await (const chunk of ctx.req) raw += chunk;
    seen = { body, files, raw };
    ctx.status = 204;
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/anything`, init);
    expect(res.status).toBe(204);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return seen!;
}

describe("bodyParser", () => {
  // Intent: the app-wide parser never parses multipart.
  // Why it exists: with multipart on, formidable wrote every file part of any
  // request to os.tmpdir(), before CSRF, session lookup or routing, and
  // nothing deleted the files. server/upload.ts parses uploads instead.
  it("leaves a multipart body unread, with an empty body", async () => {
    const form = new FormData();
    form.append("note", "hi");
    form.append("file", new Blob(["file bytes"]), "f.txt");

    const seen = await send({ method: "POST", body: form });

    expect(seen.files).toBeUndefined();
    expect(seen.body).toEqual({});
    expect(seen.raw).toContain("file bytes");
  });

  it("leaves a body of a type it does not parse unread, with an empty body", async () => {
    const seen = await send({
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "raw bytes",
    });

    expect(seen.files).toBeUndefined();
    expect(seen.body).toEqual({});
    expect(seen.raw).toBe("raw bytes");
  });

  it("parses a urlencoded form", async () => {
    const seen = await send({
      method: "POST",
      body: new URLSearchParams({ title: "Hello" }),
    });

    expect(seen.body).toEqual({ title: "Hello" });
  });
});
