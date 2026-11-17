import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Intent: each parser of client bytes has one owner. Only
// server/middleware/body.ts mounts koa-body, only server/upload.ts runs
// formidable, and only server/imaging.ts decodes images with sharp.
// Why it exists: koa-body once parsed multipart for the whole app, so any
// client could make formidable write temp files that nothing deleted. sharp
// once decoded member uploads with every libvips loader and no pixel cap.
// Another importer of any of these could quietly bring that back.
// Scenario: a route mounts koaBody({ multipart: true }) for itself, as an old
// TODO in server/routes/users.ts suggested, or calls sharp(file.buffer).

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
});
