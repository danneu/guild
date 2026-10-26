// The one owner of multipart parsing, and the only file that imports
// formidable (server/parser-owners.test.ts holds that). A route calls
// withUpload after its own authorization check. The body is parsed into
// memory, so no temp file ever exists, and every upload in the process draws
// on one byte budget, so the upload bytes held at once stay bounded.

import assert from "node:assert";
import type { IncomingMessage } from "node:http";
import { Writable } from "node:stream";
import formidable from "formidable";
import { Context } from "koa";

/**
 * The upload bytes this process may hold at once, sharp jobs included. Sized
 * to fit a few uploads at the image cap while leaving most of the VM memory
 * (fly.toml) to the rest of the app.
 */
const UPLOAD_BUDGET_BYTES = 128 * 1024 * 1024;

// All text fields of one upload together. Formidable answers 413 past it.
const MAX_FIELDS_BYTES = 64 * 1024;
const MAX_FIELDS = 16;
// How far a body may run past its file cap: its text fields plus multipart
// framing (boundaries and part headers).
const BODY_ALLOWANCE_BYTES = MAX_FIELDS_BYTES + 16 * 1024;

/** A count of reserved bytes that refuses to pass its total. */
export class ByteBudget {
  #reserved = 0;

  constructor(readonly total: number) {}

  get reserved(): number {
    return this.#reserved;
  }

  tryReserve(bytes: number): boolean {
    if (this.#reserved + bytes > this.total) return false;
    this.#reserved += bytes;
    return true;
  }

  release(bytes: number): void {
    assert(bytes <= this.#reserved, "released more upload bytes than reserved");
    this.#reserved -= bytes;
  }
}

/** Shared by every upload in this process. */
export const uploadBudget = new ByteBudget(UPLOAD_BUDGET_BYTES);

/** What one upload route accepts. */
export type UploadSpec<F extends string> = {
  /** The one file field. */
  file: string;
  /** The text fields the route reads. Others are parsed and dropped. */
  fields: readonly F[];
  /** The largest file the route accepts. */
  maxFileBytes: number;
};

export type UploadedFile = {
  buffer: Buffer;
  /** As the client declared it. */
  mimetype: string | null;
  size: number;
  originalFilename: string;
};

export type Upload<F extends string> = {
  fields: Partial<Record<F, string>>;
  /** Null when the file input was left empty or the file has no bytes. */
  file: UploadedFile | null;
};

/**
 * "too-large" means the body or its file was over the route's cap, so fn
 * never ran. The route answers it in its own words.
 */
export type UploadResult<T> =
  | { kind: "done"; value: T }
  | { kind: "too-large" };

/**
 * Parses the request's multipart body and calls fn with it, holding a
 * reservation from uploadBudget until fn settles. Answers 403 for a guest
 * before reading a byte, and 503 when the budget is full.
 */
export async function withUpload<F extends string, T>(
  ctx: Context,
  spec: UploadSpec<F>,
  fn: (upload: Upload<F>) => Promise<T>,
): Promise<UploadResult<T>> {
  // A floor under the route's own check, so a guest never reaches formidable.
  ctx.assert(ctx.currUser, 403);
  // A clear 400 before any budget is reserved. koa-body has already read JSON,
  // urlencoded and text bodies, and formidable here parses only multipart.
  ctx.assert(ctx.is("multipart"), 400, "Expected a multipart form");

  const cap = spec.maxFileBytes + BODY_ALLOWANCE_BYTES;
  // Not ctx.request.length, which keeps only the low 32 bits. Node has already
  // refused a Content-Length that is not all digits.
  const header = ctx.get("content-length");
  const declared = header === "" ? undefined : Number(header);
  if (declared !== undefined && declared > cap) return { kind: "too-large" };
  // Node delivers no more body than the declared length. A body without one
  // reserves the cap and is cut off there.
  const reserved = declared ?? cap;
  if (!uploadBudget.tryReserve(reserved)) {
    ctx.throw(503, "Too many uploads in progress. Try again in a minute.", {
      expose: true,
    });
  }
  try {
    let parsed: Parsed;
    try {
      parsed = await parseMultipart(ctx.req, spec, reserved);
    } catch (err) {
      const status = (err as { httpCode?: unknown }).httpCode;
      ctx.throw(
        typeof status === "number" ? status : 400,
        err instanceof Error ? err.message : "Bad upload",
      );
    }
    if (parsed.kind === "too-large") return { kind: "too-large" };
    ctx.assert(
      parsed.fileParts <= 1,
      400,
      `Send one file as "${spec.file}", not several`,
    );
    if (parsed.file && parsed.file.size > spec.maxFileBytes) {
      return { kind: "too-large" };
    }

    const fields: Partial<Record<F, string>> = {};
    for (const name of spec.fields) {
      const value = parsed.fields[name];
      if (typeof value === "string") fields[name] = value;
    }
    return { kind: "done", value: await fn({ fields, file: parsed.file }) };
  } finally {
    uploadBudget.release(reserved);
  }
}

type Parsed =
  | {
      kind: "parsed";
      fields: formidable.Fields;
      file: UploadedFile | null;
      // Parts that passed the filter, so more than one is a second file.
      fileParts: number;
    }
  | { kind: "too-large" };

// Runs formidable over req with file bytes collected in memory. It stops
// reading once req delivers more than maxBodyBytes, because formidable
// buffers part headers without limit and only this count bounds them.
function parseMultipart(
  req: IncomingMessage,
  spec: UploadSpec<string>,
  maxBodyBytes: number,
): Promise<Parsed> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    let fileParts = 0;
    let meta: formidable.File | null = null;

    const form = formidable({
      enabledPlugins: ["multipart"],
      maxFields: MAX_FIELDS,
      maxFieldsSize: MAX_FIELDS_BYTES,
      // The body count below bounds file bytes. Formidable's own count, which
      // differs between its versions, never decides.
      maxFileSize: Infinity,
      // A browser sends an empty file input as a part with filename="".
      // Dropping it here means it never opens a file.
      filter: (part) => part.name === spec.file && !!part.originalFilename,
      fileWriteStreamHandler: () =>
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            fileBytes += chunk.length;
            callback();
          },
        }),
    });
    form.on("fileBegin", (_name, file) => {
      fileParts += 1;
      meta = file;
    });

    let received = 0;
    let overran = false;
    let parsed = false;
    function countBody(chunk: Buffer) {
      received += chunk.length;
      // Bytes after the closing boundary are dropped, so a finished parse
      // needs no cut-off.
      if (received > maxBodyBytes && !overran && !parsed) {
        overran = true;
        // Formidable sees the error and stops parsing. The client loses the
        // connection, but only a request without Content-Length gets here.
        req.destroy(new Error("upload body passed its reservation"));
      }
    }

    form.parse(req, (err, fields) => {
      parsed = true;
      req.off("data", countBody);
      if (overran) return resolve({ kind: "too-large" });
      if (err) return reject(err);
      const buffer = Buffer.concat(chunks, fileBytes);
      // req keeps formidable, and through it these chunks, alive until the
      // request ends. Drop them so fn holds the bytes once, not twice.
      chunks.length = 0;
      resolve({
        kind: "parsed",
        fields,
        file:
          meta && fileBytes > 0
            ? {
                buffer,
                mimetype: meta.mimetype,
                size: fileBytes,
                originalFilename: meta.originalFilename ?? "",
              }
            : null,
        fileParts,
      });
    });
    req.on("data", countBody);
  });
}
