import http from "node:http";
import net, { type AddressInfo } from "node:net";
import formidable from "formidable";
import Koa, { Context } from "koa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Upload, UploadSpec, uploadBudget, withUpload } from "./upload";

// A spy that still parses, so the tests can tell whether formidable ran.
vi.mock("formidable", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof formidable }>();
  return { default: vi.fn(actual.default) };
});

const alice = { id: 1, uname: "Alice", slug: "alice", role: "member" };

const spec: UploadSpec<"submit" | "note"> = {
  file: "avatar",
  fields: ["submit", "note"],
  maxFileBytes: 100,
};

type Sent = {
  status: number | null;
  text: string | null;
  // What the handler returned: the result kind, or the error status.
  handled: string | number;
  upload: Upload<"submit" | "note"> | null;
};

// A bare Koa app whose one route calls withUpload with spec. fn records the
// upload it was given and then runs the test's own step, if any.
// A raw request is written as is and the socket dropped once the handler is
// done, for requests fetch will not send.
async function send(req: {
  currUser?: object | null;
  init?: RequestInit;
  raw?: string;
  step?: (ctx: Context) => Promise<void>;
}): Promise<Sent> {
  let upload: Sent["upload"] = null;
  let handled!: (value: string | number) => void;
  const done = new Promise<string | number>((resolve) => (handled = resolve));

  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context) => {
    ctx.currUser = req.currUser === undefined ? alice : req.currUser;
    try {
      const result = await withUpload(ctx, spec, async (u) => {
        upload = u;
        await req.step?.(ctx);
      });
      ctx.body = result.kind;
      handled(result.kind);
    } catch (err) {
      handled((err as { status: number }).status);
      throw err;
    }
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    if (req.raw !== undefined) {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", () => {});
      socket.write(req.raw);
      const value = await done;
      socket.destroy();
      return { status: null, text: null, handled: value, upload };
    }
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      ...req.init,
    }).catch(() => null);
    return {
      status: res?.status ?? null,
      text: res ? await res.text() : null,
      handled: await done,
      upload,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function form(parts: [string, string | Blob, string?][]): FormData {
  const f = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === "string") f.append(name, value);
    else f.append(name, value, filename);
  }
  return f;
}

function png(bytes: number): Blob {
  return new Blob([Buffer.alloc(bytes, 7)], { type: "image/png" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  expect(uploadBudget.reserved).toBe(0);
});

describe("withUpload", () => {
  it("hands fn the file bytes and only the listed fields", async () => {
    const sent = await send({
      init: {
        body: form([
          ["avatar", png(5), "me.png"],
          ["submit", "save"],
          ["unlisted", "dropped"],
        ]),
      },
    });

    expect(sent.status).toBe(200);
    expect(formidable).toHaveBeenCalledTimes(1);
    expect(sent.upload).toEqual({
      fields: { submit: "save" },
      file: {
        buffer: Buffer.alloc(5, 7),
        mimetype: "image/png",
        size: 5,
        originalFilename: "me.png",
      },
    });
  });

  // An empty file input arrives as a part with filename="". It must not
  // count as a file, or Delete Avatar would be refused.
  it("gives a null file for an empty file input", async () => {
    const sent = await send({
      init: {
        body: form([
          ["avatar", new Blob([]), ""],
          ["submit", "delete"],
        ]),
      },
    });

    expect(sent.status).toBe(200);
    expect(sent.upload).toEqual({ fields: { submit: "delete" }, file: null });
  });

  it("gives a null file for a named file with no bytes", async () => {
    const sent = await send({
      init: { body: form([["avatar", png(0), "empty.png"]]) },
    });

    expect(sent.upload).toEqual({ fields: {}, file: null });
  });

  it("refuses a second file part", async () => {
    const sent = await send({
      init: {
        body: form([
          ["avatar", png(5), "a.png"],
          ["avatar", png(5), "b.png"],
        ]),
      },
    });

    expect(sent.status).toBe(400);
    expect(sent.upload).toBeNull();
  });

  it("answers too-large for a file over the cap", async () => {
    const sent = await send({
      init: { body: form([["avatar", png(spec.maxFileBytes + 1), "big.png"]]) },
    });

    expect(sent.text).toBe("too-large");
    expect(sent.upload).toBeNull();
  });

  it("answers too-large before reading a body declared over the cap", async () => {
    const sent = await send({
      init: { body: form([["avatar", png(200_000), "huge.png"]]) },
    });

    expect(sent.text).toBe("too-large");
    expect(formidable).not.toHaveBeenCalled();
  });

  // Koa's ctx.request.length keeps only the low 32 bits of Content-Length,
  // which would read 2^32 + 100 as 100 and reserve far too little.
  it("reads a Content-Length past 32 bits as declared", async () => {
    const boundary = "xyzzy";
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="note"\r\n\r\n` +
      `${"n".repeat(200)}\r\n--${boundary}--\r\n`;

    const sent = await send({
      raw:
        "POST / HTTP/1.1\r\nHost: localhost\r\n" +
        `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
        `Content-Length: ${2 ** 32 + 100}\r\n\r\n` +
        body,
    });

    expect(sent.handled).toBe("too-large");
    expect(formidable).not.toHaveBeenCalled();
  });

  // Formidable buffers part headers, and skips dropped parts, without any
  // limit of its own. A body with no Content-Length is cut off at the cap.
  it("cuts off a body without Content-Length at the cap", async () => {
    const boundary = "xyzzy";
    const dropped = Buffer.alloc(200_000, 97);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="other"; filename="x.bin"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
      dropped,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });

    const sent = await send({
      init: {
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: stream,
        duplex: "half",
      } as RequestInit,
    });

    expect(sent.handled).toBe("too-large");
    expect(sent.upload).toBeNull();
  });

  it("holds the reservation while fn runs and releases it when fn throws", async () => {
    let held: number | null = null;
    let declared: number | null = null;

    const sent = await send({
      init: { body: form([["avatar", png(5), "me.png"]]) },
      step: async (ctx) => {
        held = uploadBudget.reserved;
        declared = ctx.request.length;
        throw new Error("sharp failed");
      },
    });

    expect(sent.status).toBe(500);
    expect(held).toBeGreaterThan(0);
    expect(held).toBe(declared);
  });

  it("answers 503 without parsing when the budget is full", async () => {
    const rest = uploadBudget.total - uploadBudget.reserved;
    expect(uploadBudget.tryReserve(rest)).toBe(true);
    try {
      const sent = await send({
        init: { body: form([["avatar", png(5), "me.png"]]) },
      });

      expect(sent.status).toBe(503);
      expect(formidable).not.toHaveBeenCalled();
    } finally {
      uploadBudget.release(rest);
    }
  });

  it("refuses a guest before parsing", async () => {
    const sent = await send({
      currUser: null,
      init: { body: form([["avatar", png(5), "me.png"]]) },
    });

    expect(sent.status).toBe(403);
    expect(formidable).not.toHaveBeenCalled();
  });

  it("refuses a body that is not multipart before parsing", async () => {
    const sent = await send({
      init: { body: new URLSearchParams({ submit: "delete" }) },
    });

    expect(sent.status).toBe(400);
    expect(formidable).not.toHaveBeenCalled();
  });
});
