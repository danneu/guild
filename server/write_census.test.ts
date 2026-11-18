import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Intent: each table in CENSUS has one file that may insert its rows or set
// its listed columns. For posts and topics that file is
// server/db/forum_text_writes.ts, which only server/forum_text.ts calls, so
// every post text and topic title written goes through the gates in those
// writes and on to the spam classifier. For users it is
// server/db/accounts.ts, so every account needs the signup gate's permit and
// passes the signup network cap.
// Why it exists: four of the seven routes that wrote post text or a topic
// title never handed it to the classifier (hunt 261117-0852-027), the post
// gap holds only while no other code inserts a post (hunt 261117-0852-049),
// and the signup cap only while no other code inserts a user (hunt
// 261117-0852-006). Writing those rows is just SQL, so code with a pg client
// could go around the owner without importing it.
// Scenario: a new function in server/db/index.ts runs UPDATE posts SET
// markup, or a route inserts a topic or a user with knex.

// Each guarded table: the one file that may insert its rows or set `columns`.
// An UPDATE that sets only other columns, such as is_hidden or user_id, is
// legal anywhere, and so is any update of a table with no listed columns.
const CENSUS: Record<string, { owner: string; columns: string[] }> = {
  posts: {
    owner: "server/db/forum_text_writes.ts",
    columns: ["markup", "html"],
  },
  topics: { owner: "server/db/forum_text_writes.ts", columns: ["title"] },
  users: { owner: "server/db/accounts.ts", columns: [] },
};

const repoRoot = path.resolve(__dirname, "..");

function sourceFiles(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, "server"), {
      recursive: true,
      encoding: "utf8",
    })
    .filter((file) => /\.(ts|js)$/.test(file) && !/\.test\.ts$/.test(file))
    .map((file) => path.join("server", file).split(path.sep).join("/"))
    .sort();
}

type Write = {
  table: string;
  kind: "insert" | "update";
  // For an SQL UPDATE, the columns its SET clause assigns. A knex write's
  // columns sit in an object this sweep does not read, so it has none.
  columns?: string[];
};

// A table name, word-bounded, with optional quotes and schema
const TABLE = String.raw`(?:"?\w+"?\s*\.\s*)?"?(\w+)"?`;
const INSERT = new RegExp(String.raw`\bINSERT\s+INTO\s+${TABLE}`, "gi");
const UPDATE = new RegExp(
  String.raw`\bUPDATE\s+(?:ONLY\s+)?${TABLE}(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET\b`,
  "gi",
);
// A knex builder on a table, with an optional alias
const KNEX_TABLE = new RegExp(
  String.raw`(?:\bknex|\.into|\.table|\.from)\s*\(\s*["'\`](?:\w+\.)?(\w+)(?:\s+as\s+\w+)?["'\`]\s*\)`,
  "gi",
);
const CLAUSE_END = /^(?:WHERE|FROM|RETURNING)\b/i;

// The columns a SET clause assigns, read from the text after SET up to its
// WHERE, FROM or RETURNING, the end of its string, or the end of the
// statement. Commas and keywords inside parentheses belong to an expression.
function assignedColumns(clause: string): string[] {
  const assignments: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i]!;
    if (depth === 0) {
      if (ch === "`" || ch === ";") break;
      if (!/\w/.test(clause[i - 1] ?? "") && CLAUSE_END.test(clause.slice(i)))
        break;
      if (ch === ",") {
        assignments.push(current);
        current = "";
        continue;
      }
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    current += ch;
  }
  assignments.push(current);
  // A target is a column, or a parenthesized list of them
  return assignments.flatMap((assignment) =>
    assignment
      .split("=")[0]!
      .replace(/[()"]/g, " ")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((column) => column.split(".").at(-1)!.toLowerCase()),
  );
}

// Each SQL INSERT or UPDATE and each knex insert or update in `text`
function writesIn(text: string): Write[] {
  const writes: Write[] = [];
  for (const m of text.matchAll(INSERT)) {
    writes.push({ table: m[1]!.toLowerCase(), kind: "insert" });
  }
  for (const m of text.matchAll(UPDATE)) {
    writes.push({
      table: m[1]!.toLowerCase(),
      kind: "update",
      columns: assignedColumns(text.slice(m.index + m[0].length)),
    });
  }
  // A knex statement runs to its semicolon.
  for (const statement of text.split(";")) {
    const tables = [...statement.matchAll(KNEX_TABLE)].map((m) =>
      m[1]!.toLowerCase(),
    );
    const kinds = [...statement.matchAll(/\.(insert|update|upsert)\s*\(/g)];
    for (const table of tables) {
      for (const [, kind] of kinds) {
        writes.push({ table, kind: kind === "update" ? "update" : "insert" });
      }
    }
  }
  return writes;
}

// Whether a write needs its table's owner: every insert, every knex update of
// a table with listed columns, and an SQL UPDATE that sets a listed column.
function isGuarded(write: Write): boolean {
  const entry = CENSUS[write.table];
  if (!entry) return false;
  if (write.kind === "insert") return true;
  // A knex update's columns are unknown, so it may set a listed one.
  if (!write.columns) return entry.columns.length > 0;
  return write.columns.some((column) => entry.columns.includes(column));
}

function describeWrite(write: Write): string {
  const verb = write.kind === "insert" ? "INSERT INTO" : "UPDATE";
  const set = write.columns ? ` SET ${write.columns.join(", ")}` : "";
  return `${verb} ${write.table}${set}`;
}

function guardedWrites(): { file: string; write: Write }[] {
  return sourceFiles().flatMap((file) =>
    writesIn(fs.readFileSync(path.join(repoRoot, file), "utf8"))
      .filter(isGuarded)
      .map((write) => ({ file, write })),
  );
}

describe("write census", () => {
  it("only each table's owner inserts its rows or sets its listed columns", () => {
    const outside = guardedWrites()
      .filter(({ file, write }) => file !== CENSUS[write.table]!.owner)
      .map(({ file, write }) => `${file}: ${describeWrite(write)}`);

    expect(outside).toEqual([]);
  });

  // The sweep still reads the owners' own SQL, so a change that hides a write
  // from it fails here instead of passing quietly.
  it("finds each kind of write in the owners", () => {
    const found = new Set(
      guardedWrites()
        .filter(({ file, write }) => file === CENSUS[write.table]!.owner)
        .map(({ write }) => `${write.kind} ${write.table}`),
    );

    expect([...found].sort()).toEqual([
      "insert posts",
      "insert topics",
      "insert users",
      "update posts",
      "update topics",
    ]);
  });

  // Shapes the owners' SQL does not use today
  it("keys on the table and on the columns a write sets", () => {
    const cases: [string, boolean][] = [
      [`UPDATE "public"."posts" AS p SET markup = $1 WHERE id = $2`, true],
      [`UPDATE topics SET (join_status, title) = ($1, $2)`, true],
      [`UPDATE posts SET n = (SELECT 1 FROM x WHERE y), html = $1`, true],
      [`INSERT INTO public.topics (title) VALUES ($1)`, true],
      [`knex("posts as p").where({ id }).update(fields);`, true],
      [`knex("users").insert({ uname, email });`, true],
      [`UPDATE posts SET is_hidden = true WHERE markup = $1`, false],
      [`UPDATE topics t SET user_id = $1 FROM users u`, false],
      [`INSERT INTO post_revs (markup) VALUES ($1)`, false],
      [`knex("posts as p").select("markup").where({ id });`, false],
      [`UPDATE users SET email = $1 WHERE id = $2`, false],
      [`knex("users").where({ id }).update(fields);`, false],
    ];
    for (const [sql, guarded] of cases) {
      expect(writesIn(sql).some(isGuarded), sql).toBe(guarded);
    }
  });
});
