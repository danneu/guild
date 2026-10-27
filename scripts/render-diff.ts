// Renders stored markup with server/bbcode.js from a git ref and from the
// working tree, and reports each text whose stored html would change.
//
// Finding 261026-0911-005 rewrote the URL check, the [*] pass and the nesting
// passes, and its trade-offs ask for this diff over stored markup before the
// change lands. Stored html is never re-rendered, so a difference shows what
// an edit of that row would now store.
//
// Usage:
//   pnpm exec tsx scripts/render-diff.ts --ref <ref> [--limit 1000]
//   pnpm exec tsx scripts/render-diff.ts --ref <ref> --file texts.json
//
// --ref names a commit whose server/bbcode.js is the renderer to compare
// against, such as 4e72f23, the last commit before the 261026-0911-005
// rewrite. It has no default: once the rewrite is on master, --ref master
// would compare the new renderer with itself and report no differences.
// Without --file it reads the newest --limit rows of each markup column from
// DATABASE_URL, with SELECTs only. With --file it reads a JSON array of
// markup strings. --out writes every difference to a JSON file. Each render
// runs under --time-limit ms, since the old renderer can take many seconds
// on some markup.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import vm from "node:vm";

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server");

// The markup columns of sql/1-schema.sql, with the order that picks the
// newest rows.
const SOURCES: ReadonlyArray<[table: string, column: string, order: string]> = [
  ["posts", "markup", "id"],
  ["pms", "markup", "id"],
  ["vms", "markup", "id"],
  ["users", "bio_markup", "id"],
  ["users", "sig", "id"],
  ["campaigns", "markup", "id"],
  ["albums", "markup", "id"],
  ["feedback_topics", "markup", "id"],
  ["trophy_groups", "description_markup", "id"],
  ["trophies", "description_markup", "id"],
  ["trophies_users", "message_markup", "awarded_at"],
];

type Text = { source: string; markup: string };
type Outcome = { html: string } | { failure: string };
type Difference = {
  source: string;
  markup: string;
  old: Outcome;
  new: Outcome;
};

const { values: args } = parseArgs({
  options: {
    ref: { type: "string" },
    file: { type: "string" },
    limit: { type: "string", default: "1000" },
    out: { type: "string" },
    "time-limit": { type: "string", default: "5000" },
  },
});

// Compiles a bbcode.js source as if it sat in server/, so its requires
// resolve as the real file's do. cache3 would start interval queries, so
// the renderer gets a fixed uname set in its place.
function loadRenderer(
  source: string,
  name: string,
  unames: Set<string>,
): (markup: string) => string {
  const filename = path.join(SERVER, name);
  const internals = Module as unknown as {
    _load: (request: string, parent: unknown, ...rest: unknown[]) => unknown;
    _nodeModulePaths: (dir: string) => string[];
  };
  const mod = new Module(filename) as Module & {
    _compile: (source: string, filename: string) => void;
  };
  mod.filename = filename;
  mod.paths = internals._nodeModulePaths(SERVER);
  const originalLoad = internals._load;
  internals._load = function (request, parent, ...rest) {
    if (parent === mod && request === "./cache3") {
      return { default: { get: () => unames } };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  try {
    mod._compile(source, filename);
  } finally {
    internals._load = originalLoad;
  }
  return mod.exports as (markup: string) => string;
}

function renderWithin(
  ms: number,
  render: (markup: string) => string,
  markup: string,
): Outcome {
  const context = vm.createContext({ work: () => render(markup) });
  try {
    return { html: vm.runInContext("work()", context, { timeout: ms }) };
  } catch (err) {
    const { name, message } = err as Error;
    return { failure: `${name}: ${message}` };
  }
}

async function readTexts(): Promise<{ texts: Text[]; unames: Set<string> }> {
  if (args.file) {
    const markups: unknown = JSON.parse(readFileSync(args.file, "utf8"));
    if (!Array.isArray(markups) || markups.some((m) => typeof m !== "string")) {
      throw new Error(`${args.file} must hold a JSON array of strings`);
    }
    return {
      texts: markups.map((markup) => ({ source: args.file!, markup })),
      unames: new Set(),
    };
  }
  const limit = Number.parseInt(args.limit!, 10);
  if (!(limit > 0)) throw new Error("--limit must be a positive integer");
  // Loaded here, so --file runs need no database.
  const { pool } = await import("../server/db/util");
  try {
    const texts: Text[] = [];
    for (const [table, column, order] of SOURCES) {
      const { rows } = await pool.query<{ markup: string }>(
        `SELECT ${column} AS markup FROM ${table}
         WHERE ${column} IS NOT NULL AND ${column} <> ''
         ORDER BY ${order} DESC LIMIT $1`,
        [limit],
      );
      for (const row of rows) {
        texts.push({ source: `${table}.${column}`, markup: row.markup });
      }
    }
    const { rows } = await pool.query<{ uname: string }>(
      "SELECT lower(uname) AS uname FROM users",
    );
    return { texts, unames: new Set(rows.map((row) => row.uname)) };
  } finally {
    await pool.end();
  }
}

function shown(outcome: Outcome): string {
  return "html" in outcome ? outcome.html : `(${outcome.failure})`;
}

// The two sides around their first difference.
function excerpt(a: string, b: string): [string, string] {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  return [a.slice(from, i + 100), b.slice(from, i + 100)];
}

async function main() {
  if (!args.ref) {
    throw new Error("--ref is required: the commit to compare against");
  }
  const timeLimit = Number.parseInt(args["time-limit"]!, 10);
  const oldSource = execFileSync(
    "git",
    ["show", `${args.ref}:server/bbcode.js`],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const newSource = readFileSync(path.join(SERVER, "bbcode.js"), "utf8");
  const { texts, unames } = await readTexts();
  const renderOld = loadRenderer(oldSource, "bbcode.diff-old.js", unames);
  const renderNew = loadRenderer(newSource, "bbcode.diff-new.js", unames);

  const differences: Difference[] = [];
  const counts = new Map<
    string,
    { texts: number; differ: number; oldFailed: number; newFailed: number }
  >();
  for (const { source, markup } of texts) {
    const count = counts.get(source) ?? {
      texts: 0,
      differ: 0,
      oldFailed: 0,
      newFailed: 0,
    };
    counts.set(source, count);
    count.texts++;
    const old = renderWithin(timeLimit, renderOld, markup);
    const now = renderWithin(timeLimit, renderNew, markup);
    if ("failure" in old) count.oldFailed++;
    if ("failure" in now) count.newFailed++;
    if (shown(old) === shown(now)) continue;
    count.differ++;
    differences.push({ source, markup, old, new: now });
  }

  for (const [source, count] of counts) {
    console.log(
      `${source}: ${count.differ} of ${count.texts} differ ` +
        `(old failed ${count.oldFailed}, new failed ${count.newFailed})`,
    );
  }
  for (const { source, markup, old, new: now } of differences.slice(0, 20)) {
    const [a, b] = excerpt(shown(old), shown(now));
    console.log(`\n--- ${source}, ${markup.length} chars`);
    console.log(`old: ${a}`);
    console.log(`new: ${b}`);
  }
  if (differences.length > 20) {
    console.log(
      `\n... and ${differences.length - 20} more. Use --out to see all.`,
    );
  }
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(differences, null, 2));
    console.log(`\nWrote ${differences.length} differences to ${args.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
