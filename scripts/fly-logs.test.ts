import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = "scripts/fly-logs.sh";

type LogRow = {
  id: string;
  type: string;
  attributes: {
    timestamp: string;
    message: string;
    level: string;
    instance: string;
    region: string;
    meta: Record<string, unknown>;
  };
};

let tempDir: string;
let binDir: string;
let curlCapture: string;
let flyCapture: string;

function ns(time: string): string {
  return String(BigInt(Date.parse(time)) * 1000000n);
}

function row(id: string, timestamp: string, message: string): LogRow {
  return {
    id,
    type: "app",
    attributes: {
      timestamp,
      message,
      level: "info",
      instance: "machine-a",
      region: "dfw",
      meta: {},
    },
  };
}

function writePage(name: string, rows: LogRow[], nextToken: string): string {
  const file = path.join(tempDir, name);
  writeFileSync(
    file,
    JSON.stringify({ data: rows, meta: { next_token: nextToken } }),
  );
  return file;
}

function installFakeCommands() {
  const curlPath = path.join(binDir, "curl");
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
: "\${CURL_CAPTURE:?}"
{
  printf '__CALL__\\n'
  for arg in "$@"; do
    printf '%s\\n' "$arg"
  done
} >> "$CURL_CAPTURE"

cursor=""
for arg in "$@"; do
  case "$arg" in
    next_token=*) cursor="\${arg#next_token=}" ;;
  esac
done

if [[ -n "\${PAGE1_CURSOR:-}" && "$cursor" == "$PAGE1_CURSOR" ]]; then
  cat "$PAGE1_FILE"
elif [[ -n "\${PAGE2_CURSOR:-}" && "$cursor" == "$PAGE2_CURSOR" ]]; then
  cat "$PAGE2_FILE"
else
  printf '%s\\n' '{"data":[],"meta":{"next_token":""}}'
fi
`,
  );
  chmodSync(curlPath, 0o755);

  const flyPath = path.join(binDir, "fly");
  writeFileSync(
    flyPath,
    `#!/usr/bin/env bash
set -euo pipefail
: "\${FLY_CAPTURE:?}"
{
  printf '__CALL__\\n'
  for arg in "$@"; do
    printf '%s\\n' "$arg"
  done
} >> "$FLY_CAPTURE"
printf 'dummy-token\\n'
`,
  );
  chmodSync(flyPath, 0o755);
}

function runFlyLogs(
  args: string[],
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    CURL_CAPTURE: curlCapture,
    FLY_CAPTURE: flyCapture,
    ...extraEnv,
  };
  delete env.FLY_API_TOKEN;

  return spawnSync("bash", [scriptPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function capturedCurlArgs(): string[] {
  return readFileSync(curlCapture, "utf8")
    .split("\n")
    .filter(Boolean);
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "guild-fly-logs-"));
  binDir = path.join(tempDir, "bin");
  curlCapture = path.join(tempDir, "curl-args.txt");
  flyCapture = path.join(tempDir, "fly-args.txt");
  writeFileSync(curlCapture, "");
  writeFileSync(flyCapture, "");
  mkdirSync(binDir);
  installFakeCommands();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("fly-logs.sh", () => {
  it("passes query params and default FlyV1 auth to the Logs API", () => {
    const start = "2026-07-01T12:00:00Z";
    const result = runFlyLogs([
      start,
      "2026-07-01T12:01:00Z",
      "-r",
      "dfw",
      "-i",
      "machine-a",
    ]);

    expect(result.status).toBe(0);
    const curlArgs = capturedCurlArgs();
    expect(curlArgs).toContain("--get");
    expect(curlArgs).toContain(
      "https://api.fly.io/api/v1/apps/rpguild/logs",
    );
    expect(curlArgs).toContain("Authorization: FlyV1 dummy-token");
    expect(curlArgs).toContain(`next_token=${ns(start)}`);
    expect(curlArgs).toContain("region=dfw");
    expect(curlArgs).toContain("instance=machine-a");

    const flyArgs = readFileSync(flyCapture, "utf8").split("\n");
    expect(flyArgs).toEqual(["__CALL__", "auth", "token", "-q", ""]);
  });

  it("omits server-side filters unless they are requested", () => {
    const result = runFlyLogs(["2026-07-01T12:00:00Z"]);

    expect(result.status).toBe(0);
    const curlArgs = capturedCurlArgs();
    expect(curlArgs.some((arg) => arg.startsWith("region="))).toBe(false);
    expect(curlArgs.some((arg) => arg.startsWith("instance="))).toBe(false);
  });

  it("accepts relative start time and default end time", () => {
    const result = runFlyLogs(["30m"]);

    expect(result.status).toBe(0);
    const cursor = capturedCurlArgs().find((arg) =>
      arg.startsWith("next_token="),
    );
    expect(cursor).toMatch(/^next_token=\d+$/);
  });

  it("rejects bad time input", () => {
    const result = runFlyLogs(["nope"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bad time: nope");
  });

  it("filters output with a case-insensitive grep pattern", () => {
    const start = "2026-07-01T12:00:00Z";
    const page1 = writePage(
      "page1.json",
      [
        row("1", "2026-07-01T12:00:00.000Z", "ordinary boot line"),
        row("2", "2026-07-01T12:00:01.000Z", "antispam process ALLOW"),
      ],
      "",
    );

    const result = runFlyLogs(
      [start, "2026-07-01T12:01:00Z", "-g", "ANTISPAM"],
      {
        PAGE1_CURSOR: ns(start),
        PAGE1_FILE: page1,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("antispam process ALLOW");
    expect(result.stdout).not.toContain("ordinary boot line");
  });

  it("paginates, dedups the inclusive cursor row, and stops at the live edge", () => {
    const start = "2026-07-01T12:00:00Z";
    const second = "2026-07-01T12:00:01.000Z";
    const page1 = writePage(
      "page1.json",
      [
        row("1", "2026-07-01T12:00:00.000Z", "first line"),
        row("2", second, "second line"),
      ],
      ns(second),
    );
    const page2 = writePage(
      "page2.json",
      [
        row("2", second, "second line"),
        row("3", "2026-07-01T12:00:02.000Z", "third line"),
      ],
      ns("2026-07-01T12:00:02.000Z"),
    );

    const result = runFlyLogs(
      [start, "2026-07-01T12:00:03Z"],
      {
        PAGE1_CURSOR: ns(start),
        PAGE1_FILE: page1,
        PAGE2_CURSOR: ns(second),
        PAGE2_FILE: page2,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/first line[\s\S]*second line[\s\S]*third line/);
    expect(result.stdout.match(/second line/g)).toHaveLength(1);
    expect(capturedCurlArgs().filter((arg) => arg === "__CALL__")).toHaveLength(
      3,
    );
  });
});
