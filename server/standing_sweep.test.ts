import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Intent: one module decides whether a member is still new. Outside
// server/trust.ts, server code compares users.posts_count or reads
// approved_at only in the reviewed uses below, and none of them decides
// standing.
// Why it exists: trust was posts_count > 5, which six one-line posts reach in
// a minute and which a hide never lowers. The post gap and the bio review
// each kept a posts_count cutoff of their own, so the rules could disagree
// (hunt 261117-0852-003).
// Scenario: a new gate writes `if (user.posts_count > 10)`, or a query adds
// `WHERE u.approved_at IS NOT NULL`, instead of asking server/trust.ts.

const repoRoot = path.resolve(__dirname, "..");

// Each reviewed use, as its file and the line that holds it
const REVIEWED = [
  // findAllActiveUnames: whether the member has posted at all
  "server/db/index.ts: posts_count > 0",
  // The unapprove and approve writes
  "server/db/users.ts: approved_at = NULL",
  "server/db/users.ts: approved_at = NOW()",
  // First actions: a member's first convo, a bio only after a first post,
  // and the moderators' note on a first post
  "server/routes/convos.ts: ctx.currUser.posts_count === 0",
  "server/routes/users.ts: ctx.assert(ctx.currUser.posts_count > 0 && ctx.currUser.avatar_url, 403);",
  "server/services/antispam/index.ts: if (charge.standing.posts_count === 0) {",
];

const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

// In SQL text: any approved_at, or posts_count on either side of an ordering
// or inequality. SQL's = is also assignment, so equality is not swept; a
// count of 0 is a first-action check anyway.
const SQL_USE =
  /\bapproved_at\b|\bposts_count\s*(?:<|>|!=)|(?:<|>|!=)=?\s*(?:\w+\.)?posts_count\b/g;

function sourceFiles(): string[] {
  const dir = path.join(repoRoot, "server");
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|js)$/.test(file) && !/\.test\.ts$/.test(file))
    .map((file) => path.join("server", file).split(path.sep).join("/"))
    .filter((file) => file !== "server/trust.ts")
    .sort();
}

function isPostsCount(node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "posts_count";
  }
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return ts.isStringLiteralLike(key) && key.text === "posts_count";
  }
  return ts.isIdentifier(node) && node.text === "posts_count";
}

// The 1-based lines of `text` that compare posts_count or read approved_at,
// in code or in SQL strings. It parses the file, so comments never count, and
// a type's approved_at field is not a read.
function standingUses(file: string, text: string): number[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  function mark(position: number): void {
    lines.add(source.getLineAndCharacterOfPosition(position).line + 1);
  }
  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      COMPARISONS.has(node.operatorToken.kind)
    ) {
      for (const side of [node.left, node.right]) {
        if (isPostsCount(side)) mark(side.getStart(source));
      }
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "approved_at" &&
      !ts.isPropertySignature(node.parent)
    ) {
      mark(node.getStart(source));
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const raw = node.getText(source);
      for (const match of raw.matchAll(SQL_USE)) {
        mark(node.getStart(source) + match.index);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...lines].sort((a, b) => a - b);
}

describe("member standing", () => {
  it("only server/trust.ts compares posts_count or reads approved_at", () => {
    const uses = sourceFiles().flatMap((file) => {
      const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
      const lines = text.split("\n");
      return standingUses(file, text).map(
        (line) => `${file}: ${lines[line - 1]!.trim()}`,
      );
    });
    expect(uses).toEqual(REVIEWED);
  });

  it("the sweep sees each comparison and read, in code and SQL", () => {
    const sample = [
      "if (user.posts_count > 5) {}",
      "const ok = 2 <= (u.posts_count);",
      "const q = `WHERE u.approved_at IS NOT NULL`;",
      "const r = 'SELECT 1 FROM users WHERE posts_count >= 6';",
      "const when = user.approved_at;",
      "// user.posts_count > 5, and approved_at, in a comment",
      "if (topic.ic_posts_count > 0) {}",
      "type Row = { approved_at: Date | null };",
      "const shown = user.posts_count + 1;",
      "const recount = 'SET posts_count = sub.posts_count';",
    ].join("\n");
    expect(standingUses("sample.ts", sample)).toEqual([1, 2, 3, 4, 5]);
  });
});
