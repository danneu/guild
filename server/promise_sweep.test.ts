// Fails on a promise that non-test server code drops, and on a pg connection
// made outside server/db/util.ts. Node exits on an unhandled rejection, and on
// an 'error' event that no listener hears, so either one kills every request
// on the machine. Finding 261117-0852-024 was the Discord bot dropping the
// promises from its replies and its login: a member could crash the web
// process on demand.
//
// It reads static types, built from tsconfig.json, so it sees only values
// whose type is the native Promise. A value typed any gets past it (an untyped
// let, an untyped package, a require), and so does a promise dropped inside a
// library. A promise stored in a variable or a property is left to the code
// that reads it: tsc's noUnusedLocals fails a local nobody reads, and the
// known-limit case below is a promise read but never awaited.
//
// It is a vitest, not typescript-eslint's no-floating-promises and
// no-misused-promises, because the repo has no eslint and `pnpm test` is the
// gate. no-floating-promises, like this sweep, skips thenables such as knex
// builders unless its checkThenables option is on. no-misused-promises has no
// such option and treats any thenable as a promise.

import path from "node:path";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server") + path.sep;
const POOL_OWNER = path.join(ROOT, "server", "db", "util.ts");

// Seeded misses, compiled into the same program as the real code so they
// import real modules. Each line that ends in `// miss` must be flagged by the
// rule its file names, and no other line may be.
const SEED_DIR = path.join(ROOT, "server", "__promise_sweep_seeds__");
const SEEDS: Record<string, string> = {
  "dropped.ts": `
async function work(): Promise<number> { return 1; }
export async function caller() {
  work(); // miss
  void work(); // miss
  work().then(() => {}); // miss
  work().finally(() => {}); // miss
  Math.random() > 0.5 && work(); // miss
  work().catch((err) => console.error(err));
  work().then(() => {}, (err) => console.error(err));
  await work();
  let later: Promise<number>;
  later = work();
  return later;
}
`,
  "void_context.ts": `
import { EventEmitter } from "node:events";
async function work(): Promise<void> {}
type Listener = { onDone: () => void };
export function wire(emitter: EventEmitter): Listener {
  emitter.on("x", async () => {}); // miss
  setInterval(work, 1000); // miss
  const typed: () => void = work; // miss
  const listener: Listener = { onDone: work }; // miss
  const shorthand: Listener = { onDone }; // miss
  const method: Listener = { async onDone() {} }; // miss
  let assigned: () => void = () => {};
  assigned = work; // miss
  setInterval(() => { work().catch(console.error); }, 1000);
  const awaited: () => Promise<void> = work;
  return listener;
}
async function onDone() {}
export function makeListener(): () => void {
  return work; // miss
}
export const arrow = (): (() => void) => work; // miss
`,
  "pg_outside_owner.ts": `
import pg from "pg";
import { Pool } from "pg";
export const pool = new pg.Pool(); // miss
export const other = new Pool(); // miss
export const client = new pg.Client(); // miss
`,
  "known_limit.ts": `
async function work(): Promise<void> {}
export function stored() {
  const pending = work();
  return typeof pending;
}
`,
};

type Rule = "dropped" | "void_context" | "pg_outside_owner";

type Finding = { file: string; line: number; rule: Rule; text: string };

function seedPath(name: string): string {
  return path.join(SEED_DIR, name);
}

function buildProgram(): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!parsed) throw new Error("cannot read tsconfig.json");

  const seeds = new Map(
    Object.entries(SEEDS).map(([name, text]) => [seedPath(name), text]),
  );
  const host = ts.createCompilerHost(parsed.options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const seed = seeds.get(path.normalize(fileName));
    return seed === undefined
      ? getSourceFile.call(host, fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, seed, languageVersion, true);
  };
  host.fileExists = (fileName) =>
    seeds.has(path.normalize(fileName)) || fileExists.call(host, fileName);
  host.readFile = (fileName) =>
    seeds.get(path.normalize(fileName)) ?? readFile.call(host, fileName);

  return ts.createProgram({
    rootNames: [...parsed.fileNames, ...seeds.keys()],
    options: parsed.options,
    host,
  });
}

function sweep(program: ts.Program): Finding[] {
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];

  function isNativePromise(type: ts.Type): boolean {
    if (type.isUnionOrIntersection()) return type.types.some(isNativePromise);
    const symbol = type.getSymbol();
    return (
      symbol?.getName() === "Promise" &&
      (symbol.getDeclarations() ?? []).some((decl) =>
        program.isSourceFileDefaultLibrary(decl.getSourceFile()),
      )
    );
  }

  function returnsNativePromise(type: ts.Type): boolean {
    return type
      .getCallSignatures()
      .some((sig) => isNativePromise(checker.getReturnTypeOfSignature(sig)));
  }

  function expectsVoidReturn(type: ts.Type | undefined): boolean {
    const signatures = type?.getNonNullableType().getCallSignatures() ?? [];
    return (
      signatures.length > 0 &&
      signatures.every(
        (sig) =>
          checker.getReturnTypeOfSignature(sig).flags & ts.TypeFlags.Void,
      )
    );
  }

  // `.catch(handler)`, or `.then(onFulfilled, onRejected)`.
  function isHandled(expr: ts.Expression): boolean {
    if (!ts.isCallExpression(expr)) return false;
    const callee = expr.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const name = callee.name.text;
    return (
      (name === "catch" && expr.arguments.length >= 1) ||
      (name === "then" && expr.arguments.length >= 2)
    );
  }

  function isAssignment(expr: ts.Expression): boolean {
    return (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      expr.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  }

  // The type an object literal's contextual type gives one of its members.
  function memberContextualType(
    member: ts.ObjectLiteralElementLike,
  ): ts.Type | undefined {
    if (!member.name || !ts.isIdentifier(member.name)) return undefined;
    const outer = checker.getContextualType(member.parent);
    const property = outer?.getNonNullableType().getProperty(member.name.text);
    return property && checker.getTypeOfSymbolAtLocation(property, member);
  }

  // Each value, and the type its position expects, wherever a function value
  // can land in a slot typed to return void.
  function voidSlots(node: ts.Node): Array<[ts.Node, ts.Type | undefined]> {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      return (node.arguments ?? []).map((arg) => [
        arg,
        checker.getContextualType(arg),
      ]);
    }
    if (ts.isPropertyAssignment(node)) {
      return [[node.initializer, checker.getContextualType(node.initializer)]];
    }
    if (
      ts.isShorthandPropertyAssignment(node) ||
      (ts.isMethodDeclaration(node) &&
        ts.isObjectLiteralExpression(node.parent))
    ) {
      return [[node, memberContextualType(node)]];
    }
    if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
      return [[node.initializer, checker.getContextualType(node.initializer)]];
    }
    if (ts.isReturnStatement(node) && node.expression) {
      return [[node.expression, checker.getContextualType(node.expression)]];
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      return [[node.body, checker.getContextualType(node.body)]];
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return [[node.right, checker.getContextualType(node.right)]];
    }
    return [];
  }

  for (const sourceFile of program.getSourceFiles()) {
    const file = path.normalize(sourceFile.fileName);
    if (
      !file.startsWith(SERVER) ||
      sourceFile.isDeclarationFile ||
      file.endsWith(".test.ts")
    ) {
      continue;
    }

    function report(node: ts.Node, rule: Rule) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      findings.push({
        file: path.relative(ROOT, file),
        line: line + 1,
        rule,
        text: node.getText(sourceFile).split("\n")[0]!.slice(0, 80),
      });
    }

    function visit(node: ts.Node) {
      if (ts.isExpressionStatement(node)) {
        let expr = ts.skipParentheses(node.expression);
        if (ts.isVoidExpression(expr))
          expr = ts.skipParentheses(expr.expression);
        if (
          !isAssignment(expr) &&
          !isHandled(expr) &&
          isNativePromise(checker.getTypeAtLocation(expr))
        ) {
          report(node, "dropped");
        }
      }

      for (const [value, expected] of voidSlots(node)) {
        if (
          expectsVoidReturn(expected) &&
          returnsNativePromise(checker.getTypeAtLocation(value))
        ) {
          report(value, "void_context");
        }
      }

      if (ts.isNewExpression(node) && file !== POOL_OWNER) {
        const symbol = checker.getTypeAtLocation(node).getSymbol();
        const fromPg = (symbol?.getDeclarations() ?? []).some((decl) =>
          /[\\/]@types[\\/]pg[\\/]/.test(decl.getSourceFile().fileName),
        );
        if (fromPg && ["Pool", "Client"].includes(symbol!.getName())) {
          report(node, "pg_outside_owner");
        }
      }

      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  return findings;
}

function markedLines(name: string): number[] {
  return SEEDS[name]!.split("\n").flatMap((line, i) =>
    line.endsWith("// miss") ? [i + 1] : [],
  );
}

describe("promise sweep", () => {
  let findings: Finding[];

  beforeAll(() => {
    findings = sweep(buildProgram());
  }, 60_000);

  function inSeed(name: string): Finding[] {
    const file = path.relative(ROOT, seedPath(name));
    return findings.filter((finding) => finding.file === file);
  }

  it("finds nothing in server code", () => {
    const real = findings.filter(
      (finding) => !finding.file.startsWith(path.relative(ROOT, SEED_DIR)),
    );
    expect(
      real,
      "End a dropped promise in .catch(handler), await it, or return it. Hand a void slot a sync function that does that. Make pg connections only in server/db/util.ts, which gives each one an 'error' listener.",
    ).toEqual([]);
  });

  for (const rule of ["dropped", "void_context", "pg_outside_owner"] as const) {
    it(`flags every seeded ${rule} miss and nothing else`, () => {
      const found = inSeed(`${rule}.ts`);
      expect(found.every((finding) => finding.rule === rule)).toBe(true);
      expect(found.map((finding) => finding.line)).toEqual(
        markedLines(`${rule}.ts`),
      );
    });
  }

  // A promise stored in a variable is outside the sweep. tsc fails one that
  // nobody reads (noUnusedLocals), but not one that is read and never awaited.
  it("known limit: passes a promise stored and never awaited", () => {
    expect(inSeed("known_limit.ts")).toEqual([]);
  });
});
