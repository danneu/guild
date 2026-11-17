import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  nodeRuntimeProblems,
  readNodeRuntime,
  scheduleProblems,
  WARN_DAYS,
} from "./node-runtime";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function repoFile(name: string): string {
  return readFileSync(path.join(repoRoot, name), "utf8");
}

function dockerfile(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

function packageJson(typesNode: string): string {
  return JSON.stringify({ devDependencies: { "@types/node": typesNode } });
}

const DIGEST = "a".repeat(64);
const GOOD = dockerfile(
  "# node-eol: 2028-04-30",
  "FROM node:24-alpine AS base",
  "",
  "FROM base AS build",
  "RUN corepack enable",
  "",
  "FROM base",
  'CMD ["node", "server/index.js"]',
);
const PINNED = GOOD.replace(
  "node:24-alpine AS",
  `node:24-alpine@sha256:${DIGEST} AS`,
);
const DAY_MS = 24 * 60 * 60 * 1000;
const BEFORE_EOL = new Date("2026-11-17T12:00:00Z");

// Intent: the repo's own Node line, checked with the real date.
// Why it exists: production and CI ran Node 23 for 17 months past its
// 2025-06-01 end-of-life. The major sat in three places with no owner, and
// nothing failed on the date. A June 2026 plan flagged it, and that warning
// changed nothing.
// Scenario: a later bump edits one Dockerfile stage but not @types/node, or
// the base stage's end-of-life date passes with nobody watching.
describe("the repo's Node runtime", () => {
  it("is named once, in the Dockerfile base stage, and is still supported", () => {
    expect(
      nodeRuntimeProblems(
        repoFile("Dockerfile"),
        repoFile("package.json"),
        new Date(),
      ),
    ).toEqual([]);
  });
});

// Intent: CI's shell parse reads the same major as readNodeRuntime, and
// fails unless exactly one line is the base stage.
// Why it exists: setup-node given an empty version uses the runner's own
// Node, so a parse that printed nothing would test on a Node production
// never runs.
// Scenario: the two patterns drift apart, or a second base line appears.
describe("scripts/node-major.sh", () => {
  // The script reads ../Dockerfile beside itself, so each run gets a copy.
  function nodeMajor(dockerfileText: string) {
    const root = mkdtempSync(path.join(tmpdir(), "node-major-"));
    try {
      mkdirSync(path.join(root, "scripts"));
      const script = path.join(root, "scripts", "node-major.sh");
      copyFileSync(path.join(repoRoot, "scripts", "node-major.sh"), script);
      writeFileSync(path.join(root, "Dockerfile"), dockerfileText);
      return spawnSync("bash", [script], { encoding: "utf8" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it.each([
    ["the repo's Dockerfile", repoFile("Dockerfile")],
    ["a digest on the base line", PINNED],
  ])("prints the base stage's major from %s", (_label, text) => {
    const run = nodeMajor(text);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`${readNodeRuntime(text).major}\n`);
    expect(run.status).toBe(0);
  });

  it.each([
    ["no base line", GOOD.replace(" AS base", "")],
    ["two base lines", GOOD + "FROM node:24-alpine AS base\n"],
  ])("fails with %s", (_label, text) => {
    const run = nodeMajor(text);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/want one line matching/);
    expect(run.status).not.toBe(0);
  });
});

describe("nodeRuntimeProblems", () => {
  it("accepts one node FROM in the base stage with @types/node on its major", () => {
    expect(
      nodeRuntimeProblems(GOOD, packageJson("^24.0.3"), BEFORE_EOL),
    ).toEqual([]);
  });

  it("accepts a digest on the base line", () => {
    expect(readNodeRuntime(PINNED)).toEqual({ major: 24, eol: "2028-04-30" });
  });

  it.each([
    "FROM node:24-alpine",
    "from node:22-alpine",
    "FROM --platform=linux/amd64 docker.io/library/node:24-alpine",
    `FROM node@sha256:${DIGEST}`,
    "FROM localhost:5000/node:24 AS tools",
  ])("refuses a second stage that pulls node: %s", (line) => {
    const twice = GOOD.replace("FROM base\n", `${line}\n`);
    expect(
      nodeRuntimeProblems(twice, packageJson("^24.0.3"), BEFORE_EOL),
    ).toEqual([expect.stringMatching(/found 2 \(lines 2, 7\)/)]);
  });

  it.each([
    ["no stage name", "FROM node:24-alpine"],
    ["another stage name", "FROM node:24-alpine AS build"],
    ["a minor version", "FROM node:24.11-alpine AS base"],
    ["a non-alpine variant", "FROM node:24-slim AS base"],
  ])("refuses a node FROM with %s", (_label, line) => {
    const off = GOOD.replace("FROM node:24-alpine AS base", line);
    expect(() => readNodeRuntime(off)).toThrow(
      /want `FROM node:<major>-alpine/,
    );
  });

  it("refuses a base stage without the node-eol line directly above it", () => {
    const apart = GOOD.replace("\nFROM node", "\n\nFROM node");
    expect(() => readNodeRuntime(apart)).toThrow(/node-eol/);
    const bad = GOOD.replace("2028-04-30", "2028-02-30");
    expect(() => readNodeRuntime(bad)).toThrow(/node-eol/);
  });

  it.each(["^22.0.0", "~26.1.0", ">=24", ""])(
    "refuses @types/node %j beside Node 24",
    (range) => {
      expect(nodeRuntimeProblems(GOOD, packageJson(range), BEFORE_EOL)).toEqual(
        [expect.stringMatching(/@types\/node/)],
      );
    },
  );

  // Intent: the gate fails the first UTC day after the committed date.
  // Why it exists: pnpm test is the deploy gate, so a dead runtime cannot
  // deploy without a visible edit.
  // Scenario: Node 23's own line, end-of-life on 2025-06-01.
  it("passes on the end-of-life date and fails the day after", () => {
    const node23 = dockerfile(
      "# node-eol: 2025-06-01",
      "FROM node:23-alpine AS base",
    );
    const types = packageJson("^23.0.0");
    expect(
      nodeRuntimeProblems(node23, types, new Date("2025-06-01T23:59:59Z")),
    ).toEqual([]);
    expect(
      nodeRuntimeProblems(node23, types, new Date("2025-06-02T00:00:00Z")),
    ).toEqual([
      expect.stringMatching(/Node 23 reached end-of-life on 2025-06-01/),
    ]);
  });
});

describe("scheduleProblems", () => {
  // Shaped like https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
  const SCHEDULE = {
    v23: { start: "2024-10-16", maintenance: "2025-04-01", end: "2025-06-01" },
    v24: {
      start: "2025-05-06",
      lts: "2025-10-28",
      maintenance: "2026-10-20",
      end: "2028-04-30",
      codename: "Krypton",
    },
  };
  const NODE_24 = { major: 24, eol: "2028-04-30" };

  it("passes an LTS line whose committed end date matches the schedule", () => {
    expect(scheduleProblems(NODE_24, SCHEDULE, BEFORE_EOL)).toEqual([]);
  });

  it("fails a line the schedule gives no LTS date", () => {
    const node23 = { major: 23, eol: "2025-06-01" };
    expect(
      scheduleProblems(node23, SCHEDULE, new Date("2024-11-01T00:00:00Z")),
    ).toEqual([expect.stringMatching(/Node 23 is not an LTS line/)]);
  });

  it("fails when the committed end date differs from the schedule's", () => {
    expect(
      scheduleProblems({ major: 24, eol: "2028-05-31" }, SCHEDULE, BEFORE_EOL),
    ).toEqual([expect.stringMatching(/2028-05-31.*2028-04-30/)]);
  });

  it("fails once fewer than WARN_DAYS remain", () => {
    const eol = Date.parse("2028-04-30T00:00:00Z");
    const lastQuiet = new Date(eol - WARN_DAYS * DAY_MS);
    const firstWarning = new Date(eol - (WARN_DAYS - 1) * DAY_MS);
    expect(scheduleProblems(NODE_24, SCHEDULE, lastQuiet)).toEqual([]);
    expect(scheduleProblems(NODE_24, SCHEDULE, firstWarning)).toEqual([
      expect.stringMatching(
        new RegExp(`end-of-life on 2028-04-30, ${WARN_DAYS - 1} days from`),
      ),
    ]);
  });

  it.each([
    ["no entry for the major", { v22: SCHEDULE.v24 }],
    ["a schedule that is not an object", null],
    ["an entry that is not an object", { v24: "2028-04-30" }],
    ["an end that is not a date", { v24: { ...SCHEDULE.v24, end: 20280430 } }],
    ["an lts that is not a date", { v24: { ...SCHEDULE.v24, lts: true } }],
  ])("fails on %s", (_label, schedule) => {
    expect(scheduleProblems(NODE_24, schedule, BEFORE_EOL)).not.toEqual([]);
  });
});
