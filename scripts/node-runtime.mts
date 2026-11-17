// Reads and checks the Node line that the Dockerfile's base stage owns.
//
// `FROM node:<major>-alpine AS base` names the one Node major that the image,
// CI (scripts/node-major.sh) and @types/node all follow. The
// `# node-eol: YYYY-MM-DD` line right above it holds that major's end-of-life
// date. scripts/node-runtime.test.ts holds pnpm test to nodeRuntimeProblems,
// which needs no network. Run as a script, this file checks the line against
// Node's release schedule (scheduleProblems), which
// .github/workflows/watch.yml does weekly.
//
// Usage: node scripts/node-runtime.mts
// Node strips the types itself, so this file imports only node builtins. The
// .mts extension makes it an ES module whatever package.json says.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// scripts/node-major.sh matches the same pattern.
const BASE_LINE = /^FROM node:([0-9]+)-alpine(@sha256:[0-9a-f]{64})? AS base$/;
const EOL_LINE = /^# node-eol: ([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

/**
 * Days of warning the weekly watch gives before end-of-life, so the move to
 * the next LTS major starts well before pnpm test blocks deploys.
 */
export const WARN_DAYS = 90;

const SCHEDULE_URL =
  "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
const DAY_MS = 24 * 60 * 60 * 1000;

export type NodeRuntime = { major: number; eol: string };

/**
 * Reads the base stage's Node major and end-of-life date. Throws unless
 * exactly one FROM pulls a node image, that FROM is the base line, and the
 * node-eol line sits directly above it.
 */
export function readNodeRuntime(dockerfile: string): NodeRuntime {
  const lines = dockerfile.split(/\r?\n/);
  const nodeFroms = lines.flatMap((line, i) => (pullsNode(line) ? [i] : []));
  const at = nodeFroms[0];
  if (nodeFroms.length !== 1 || at === undefined) {
    const where = nodeFroms.map((i) => i + 1).join(", ");
    throw new Error(
      `Dockerfile: want exactly one FROM that pulls a node image, the base ` +
        `stage; found ${nodeFroms.length}${where ? ` (lines ${where})` : ""}`,
    );
  }
  const base = BASE_LINE.exec(lines[at] ?? "");
  if (!base?.[1]) {
    throw new Error(
      `Dockerfile line ${at + 1}: want \`FROM node:<major>-alpine AS base\`, ` +
        `got \`${lines[at]}\``,
    );
  }
  const eol = EOL_LINE.exec(lines[at - 1] ?? "")?.[1];
  if (!eol || !isDate(eol)) {
    throw new Error(
      `Dockerfile line ${at}: want \`# node-eol: YYYY-MM-DD\` directly above ` +
        `the base stage, holding the major's end-of-life date`,
    );
  }
  return { major: Number(base[1]), eol };
}

/**
 * The rules pnpm test holds with no network: the Dockerfile names Node once,
 * in its base stage, @types/node is on the same major, and today (UTC) is not
 * past the committed end-of-life date. Takes today so tests can move it.
 */
export function nodeRuntimeProblems(
  dockerfile: string,
  packageJson: string,
  today: Date,
): string[] {
  let runtime: NodeRuntime;
  try {
    runtime = readNodeRuntime(dockerfile);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const problems: string[] = [];
  const types = typesNodeRange(packageJson);
  if (majorOf(types) !== runtime.major) {
    problems.push(
      `package.json: @types/node is ${JSON.stringify(types)}, but the ` +
        `Dockerfile base stage runs Node ${runtime.major}. Use ^${runtime.major}.`,
    );
  }
  if (dayOf(today) > runtime.eol) {
    problems.push(
      `Node ${runtime.major} reached end-of-life on ${runtime.eol}. Move the ` +
        `Dockerfile base stage, its node-eol line and @types/node to the next ` +
        `LTS major.`,
    );
  }
  return problems;
}

/**
 * The rules only Node's release schedule can answer: the major is an LTS
 * line, its end date matches the committed one, and at least WARN_DAYS remain.
 * The schedule comes from the network, so every field is checked before use.
 */
export function scheduleProblems(
  runtime: NodeRuntime,
  schedule: unknown,
  today: Date,
): string[] {
  const key = `v${runtime.major}`;
  const entry = isRecord(schedule) ? schedule[key] : undefined;
  if (!isRecord(entry)) {
    return [`Node's release schedule has no entry for ${key}`];
  }
  const problems: string[] = [];
  if (!isDate(entry.lts)) {
    problems.push(
      `Node ${runtime.major} is not an LTS line: the schedule gives ${key} ` +
        `no lts date`,
    );
  }
  if (!isDate(entry.end)) {
    problems.push(
      `Node's release schedule gives ${key} no end date: ` +
        JSON.stringify(entry.end),
    );
  } else if (entry.end !== runtime.eol) {
    problems.push(
      `Dockerfile node-eol is ${runtime.eol}, but Node's release schedule ` +
        `ends ${key} on ${entry.end}`,
    );
  }
  const left = Math.round(
    (Date.parse(`${runtime.eol}T00:00:00Z`) -
      Date.parse(`${dayOf(today)}T00:00:00Z`)) /
      DAY_MS,
  );
  if (left < WARN_DAYS) {
    problems.push(
      `Node ${runtime.major} reaches end-of-life on ${runtime.eol}, ${left} ` +
        `days from today. Move the Dockerfile base stage, its node-eol line ` +
        `and @types/node to the next LTS major before then: pnpm test fails ` +
        `the day after.`,
    );
  }
  return problems;
}

// A FROM pulls a node image when its repository's last path segment is
// "node", whatever the registry, tag, digest or flags. A FROM that names a
// stage, such as `FROM base`, does not.
function pullsNode(line: string): boolean {
  const image = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(line)?.[1];
  if (!image) return false;
  const ref = image.split("@")[0] ?? "";
  const name = ref.slice(ref.lastIndexOf("/") + 1).split(":")[0] ?? "";
  return name.toLowerCase() === "node";
}

function typesNodeRange(packageJson: string): unknown {
  const pkg: unknown = JSON.parse(packageJson);
  if (!isRecord(pkg)) return undefined;
  for (const deps of [pkg.devDependencies, pkg.dependencies]) {
    if (isRecord(deps) && deps["@types/node"] !== undefined) {
      return deps["@types/node"];
    }
  }
  return undefined;
}

// The major a caret, tilde or exact range pins, or null for any other range.
function majorOf(range: unknown): number | null {
  if (typeof range !== "string") return null;
  const major = /^[\^~]?([0-9]+)(?:\.|$)/.exec(range)?.[1];
  return major === undefined ? null : Number(major);
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// A real calendar day as YYYY-MM-DD; a rolled-over day such as 2028-02-30
// fails the round trip.
function isDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
  ) {
    return false;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && dayOf(new Date(ms)) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const dockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  const runtime = readNodeRuntime(dockerfile);
  const res = await fetch(SCHEDULE_URL);
  if (!res.ok) {
    throw new Error(`GET ${SCHEDULE_URL} answered ${res.status}`);
  }
  const problems = scheduleProblems(runtime, await res.json(), new Date());
  if (problems.length === 0) {
    console.log(
      `Node ${runtime.major} is an LTS line, supported until ${runtime.eol}.`,
    );
    return;
  }
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
