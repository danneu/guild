import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Intent: each parser of client bytes has one owner. Only
// server/middleware/body.ts mounts koa-body, only server/upload.ts runs
// formidable, and only server/imaging.ts decodes images with sharp. What
// members store has one owner too: only server/s3.ts calls the S3 SDK, only
// server/storage.ts calls server/s3.ts, and only server/forum_text.ts calls
// the writes of post text and topic titles in server/db/forum_text_writes.ts.
// Why it exists: koa-body once parsed multipart for the whole app, so any
// client could make formidable write temp files that nothing deleted. sharp
// once decoded member uploads with every libvips loader and no pixel cap.
// Routes once wrote to S3 with no per-account cap and built their own keys
// (hunt 261117-0852-013). Routes once saved post edits that the spam
// classifier never saw (hunt 261117-0852-027). Another importer of any of
// these could quietly bring that back.
// Scenario: a route mounts koaBody({ multipart: true }) for itself, as an old
// TODO in server/routes/users.ts suggested, calls sharp(file.buffer), puts
// an object in S3 itself, or saves a post edit with the raw write.

const repoRoot = path.resolve(__dirname, "..");

function sourceFiles(): string[] {
  const dir = path.join(repoRoot, "server");
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|js)$/.test(file) && !/\.test\.ts$/.test(file))
    .map((file) => path.join("server", file).split(path.sep).join("/"))
    .sort();
}

// Matches import, export-from, side-effect import, dynamic import() and
// require() of the package or a path inside it.
function importersOf(pkg: string): string[] {
  const name = pkg.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']` +
      name +
      String.raw`(?:/[^"']*)?["']`,
  );
  return sourceFiles().filter((file) =>
    pattern.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
  );
}

// Each file that imports the module at `target`, a repo path without its
// extension, by a relative path.
function importersOfModule(target: string): string[] {
  const specifier =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']*)["']/g;
  return sourceFiles().filter((file) => {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    return [...text.matchAll(specifier)].some(
      (match) =>
        path.posix
          .join(path.posix.dirname(file), match[1]!)
          .replace(/\.(ts|js)$/, "") === target,
    );
  });
}

describe("parser owners", () => {
  it("only server/middleware/body.ts imports koa-body", () => {
    expect(importersOf("koa-body")).toEqual(["server/middleware/body.ts"]);
  });

  it("only server/upload.ts imports formidable", () => {
    expect(importersOf("formidable")).toEqual(["server/upload.ts"]);
  });

  it("only server/imaging.ts imports sharp", () => {
    expect(importersOf("sharp")).toEqual(["server/imaging.ts"]);
  });

  it("only server/s3.ts imports the S3 SDK", () => {
    expect(importersOf("@aws-sdk/client-s3")).toEqual(["server/s3.ts"]);
  });

  it("only server/storage.ts imports server/s3.ts", () => {
    expect(importersOfModule("server/s3")).toEqual(["server/storage.ts"]);
  });

  it("only server/forum_text.ts imports server/db/forum_text_writes.ts", () => {
    expect(importersOfModule("server/db/forum_text_writes")).toEqual([
      "server/forum_text.ts",
    ]);
  });
});

// Intent: each client that calls another service has one owner, and the
// owner's call sets a deadline that covers the whole call. Only
// server/outbound.ts uses the global fetch, and its fetchWithin takes the
// deadline as a required argument. Each SDK with its own HTTP stack has one
// importer, which sets that SDK's deadline.
// Why it exists: the Turnstile check once called fetch with no deadline, and
// Node's fetch waits minutes for a stalled server. So a slow Cloudflare held
// every signup open instead of failing the check (hunt 261117-0852-025).
// Scenario: a new integration calls fetch(url) on a request path, or a route
// imports an SDK and sends with no abort signal.

// Names whose fetch property is the global fetch
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);

// Whether `node` is a member or key named fetch, such as a cache3 entry's
// fetch or keyConfig.fetch, rather than a read of the global. A shorthand
// { fetch } reads the global.
function isMemberName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return !(
      ts.isIdentifier(parent.expression) &&
      GLOBAL_OBJECTS.has(parent.expression.text)
    );
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return !(
      ts.isIdentifier(parent.left) && GLOBAL_OBJECTS.has(parent.left.text)
    );
  }
  return (
    (ts.isObjectLiteralElementLike(parent) ||
      ts.isClassElement(parent) ||
      ts.isTypeElement(parent)) &&
    (parent as { name?: ts.Node }).name === node
  );
}

// The line of each read of the global fetch in `text`: a call, a typeof, an
// assignment, an argument, or globalThis.fetch. It parses the file, so
// comments and strings never count.
function globalFetchLines(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === "fetch" && !isMemberName(node)) {
      const at = source.getLineAndCharacterOfPosition(node.getStart(source));
      lines.push(at.line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

describe("network client owners", () => {
  it("only server/outbound.ts uses the global fetch", () => {
    const uses = sourceFiles()
      .filter((file) => file !== "server/outbound.ts")
      .flatMap((file) =>
        globalFetchLines(
          file,
          fs.readFileSync(path.join(repoRoot, file), "utf8"),
        ).map((line) => `${file}:${line}`),
      );
    expect(uses).toEqual([]);
  });

  it("the fetch sweep sees each read of the global and no member", () => {
    const sample = [
      "fetch(url);",
      "const f: typeof fetch = fetch;",
      "globalThis.fetch(url);",
      "use({ fetch });",
      "const entry = { fetch: () => load(), async fetch2() {} };",
      "entry.fetch(); keyConfig.fetch;",
      "type Entry = { fetch: () => void; fetch2(): void };",
      "const { fetch: load } = entry;",
      "// fetch(url) in a comment, and 'fetch(url)' in a string",
    ].join("\n");
    expect(globalFetchLines("sample.ts", sample)).toEqual([1, 2, 2, 3, 4]);
  });

  it("only server/emailer.ts imports the SES SDK and nodemailer", () => {
    expect(importersOf("@aws-sdk/client-sesv2")).toEqual(["server/emailer.ts"]);
    expect(importersOf("nodemailer")).toEqual(["server/emailer.ts"]);
  });

  it("only server/routes/discord.ts imports simple-oauth2", () => {
    expect(importersOf("simple-oauth2")).toEqual(["server/routes/discord.ts"]);
  });

  it("only server/services/antispam/claude.ts imports the Anthropic SDK", () => {
    expect(importersOf("@anthropic-ai/sdk")).toEqual([
      "server/services/antispam/claude.ts",
    ]);
  });

  // The gateway bot, which no request waits on
  it("only server/guildbot.ts imports discord.js", () => {
    expect(importersOf("discord.js")).toEqual(["server/guildbot.ts"]);
  });
});
