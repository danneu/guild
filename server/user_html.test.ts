import fs from "node:fs";
import path from "node:path";
import pgUtils from "pg/lib/utils.js";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { sanitizeUserHtml, unwrapUserHtml } from "./user_html";

// Intent: html text leaves a UserHtml only through unwrapUserHtml, which
// takes nothing but html from sanitizeUserHtml, and only db writers call it.
// Why it exists: hunt 261117-0852-030. ctx.vals, request bodies and many rows
// are typed any, so tsc lets a plain string reach a writer typed UserHtml.
// Pages print every stored html column unescaped, so such a string would be
// stored XSS.
// Scenario: a route passes ctx.vals.text as html, a writer binds its
// UserHtml without unwrapping it, or a route unwraps one to feed a writer
// that takes a string.
describe("UserHtml", () => {
  it("gives up its text only through unwrapUserHtml", () => {
    const html = sanitizeUserHtml("hi<script>alert(1)</script>");
    expect(unwrapUserHtml(html)).toBe("hi");

    const raw: any = "<script>alert(1)</script>";
    expect(() => unwrapUserHtml(raw)).toThrow(TypeError);

    // How pg binds each query value
    expect(() => pgUtils.prepareValue(html)).toThrow(/unwrapUserHtml/);
    expect(() => `${html}`).toThrow(/unwrapUserHtml/);
    expect(() => JSON.stringify(html)).toThrow(/unwrapUserHtml/);
  });

  const repoRoot = path.resolve(__dirname, "..");

  function sourceFiles(): string[] {
    const dir = path.join(repoRoot, "server");
    return fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|js)$/.test(file) && !/\.test\.ts$/.test(file))
      .map((file) => path.join("server", file).split(path.sep).join("/"))
      .sort();
  }

  // Whether `text` names unwrapUserHtml outside comments and strings: an
  // import, a call, or a property read.
  function namesUnwrap(file: string, text: string): boolean {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    function visit(node: ts.Node): boolean {
      if (ts.isIdentifier(node) && node.text === "unwrapUserHtml") return true;
      return ts.forEachChild(node, visit) ?? false;
    }
    return visit(source);
  }

  it("is unwrapped only in server/db", () => {
    const users = sourceFiles().filter(
      (file) =>
        file !== "server/user_html.ts" &&
        namesUnwrap(file, fs.readFileSync(path.join(repoRoot, file), "utf8")),
    );
    expect(users).toContain("server/db/index.ts");
    expect(users.filter((file) => !file.startsWith("server/db/"))).toEqual([]);
  });
});
