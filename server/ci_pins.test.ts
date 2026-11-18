// Sweeps the CI config for third-party code that runs under a name its owner
// can move. Actions pin to a commit, flyctl pins to a version and a sha256 in
// the one workflow that holds FLY_API_TOKEN, and the Dockerfile base stage is
// the only image that tracks a tag. docs/agents/deploy.md#ci-pins states the
// rule.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(__dirname, "..");
const FLY_DEPLOY = "./.github/workflows/fly-deploy.yml";
const FLY_DEPLOY_FILE = FLY_DEPLOY.slice(2);

type Key = string | number;
type Step = {
  shell?: unknown;
  env?: Record<string, unknown>;
  run?: unknown;
};

function yamlFiles(): string[] {
  return fs
    .readdirSync(path.join(repoRoot, ".github"), {
      recursive: true,
      encoding: "utf8",
    })
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => path.join(".github", file).split(path.sep).join("/"))
    .sort();
}

function load(file: string): any {
  return parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
}

function workflows(): { file: string; doc: any }[] {
  return yamlFiles()
    .filter((file) => file.startsWith(".github/workflows/"))
    .map((file) => ({ file, doc: load(file) }));
}

// Every node of a parsed YAML tree with its path from the root. The parser
// drops comments, so a comment never counts.
function* walk(
  value: unknown,
  at: Key[] = [],
): Generator<{ at: Key[]; value: unknown }> {
  yield { at, value };
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* walk(item, [...at, i]);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield* walk(item, [...at, key]);
    }
  }
}

const TOUCHES_FLY = /flyctl|superfly\/|FLY_API_TOKEN/;

// Where each workflow installs or runs flyctl or reads FLY_API_TOKEN, one
// entry per step or other place. fly-deploy.yml declaring the secret, and a
// job passing it to fly-deploy.yml by name, are not places: they hand the
// token on and run nothing.
function flyPlaces(): string[] {
  const places = new Set<string>();
  for (const { file, doc } of workflows()) {
    for (const { at, value } of walk(doc)) {
      const key = at.at(-1);
      const [top, job, field, index] = at;
      // `secrets: inherit` hands every secret on, the token included.
      const inherits =
        top === "jobs" &&
        field === "secrets" &&
        at.length === 3 &&
        value === "inherit";
      const touches =
        inherits ||
        (typeof key === "string" && TOUCHES_FLY.test(key)) ||
        (typeof value === "string" && TOUCHES_FLY.test(value));
      if (!touches) continue;
      const declares =
        file === FLY_DEPLOY_FILE &&
        top === "on" &&
        job === "workflow_call" &&
        field === "secrets" &&
        index === "FLY_API_TOKEN";
      const passes =
        top === "jobs" &&
        field === "secrets" &&
        index === "FLY_API_TOKEN" &&
        at.length === 4 &&
        doc.jobs?.[job as string]?.uses === FLY_DEPLOY;
      if (declares || passes) continue;
      places.add(
        top === "jobs" && field === "steps" && typeof index === "number"
          ? `${file} jobs.${job}.steps[${index}]`
          : `${file} ${at.join(".")}`,
      );
    }
  }
  return [...places].sort();
}

function sha256(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

// Intent: nothing a third party can move runs in a CI job. Every `uses:` is
// local or a full commit SHA, flyctl comes from one release whose sha256 is
// committed beside its version, and the deploy step checks that hash before
// it runs flyctl.
// Why it exists: deploy.yml and rollback.yml ran
// superfly/flyctl-actions/setup-flyctl@master, which installs whatever flyctl
// api.fly.io names at run time with no hash check, and then handed that
// binary FLY_API_TOKEN, which can replace production. The Claude workflows
// ran claude-code-action on movable @beta tags with Claude secrets, and the
// @claude one, since deleted, handed the owner's OAuth tokens to an
// individual's fork. A tag can be moved: the 2025 tj-actions/changed-files
// compromise moved existing tags.
// Scenario: a push to setup-flyctl's master, a replaced flyctl release
// asset, or a moved @beta tag runs in a job that holds a secret, or a snippet
// pasted from Fly's docs brings @master back.
describe("CI pins", () => {
  it("pins every action to a full commit SHA", () => {
    const pinned = /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
    const loose: string[] = [];
    for (const file of yamlFiles()) {
      for (const { at, value } of walk(load(file))) {
        if (at.at(-1) !== "uses") continue;
        if (typeof value === "string" && value.startsWith("./")) continue;
        if (typeof value === "string" && pinned.test(value)) continue;
        loose.push(`${file}: ${String(value)}`);
      }
    }
    expect(loose).toEqual([]);
  });

  it("keeps flyctl and FLY_API_TOKEN in one step, which checks flyctl's sha256 before it runs flyctl", () => {
    const places = flyPlaces();
    expect(places).toEqual([
      expect.stringMatching(
        /^\.github\/workflows\/fly-deploy\.yml jobs\.[\w-]+\.steps\[\d+\]$/,
      ),
    ]);
    const [, job, index] = /jobs\.([\w-]+)\.steps\[(\d+)\]$/.exec(places[0]!)!;
    const step: Step = load(FLY_DEPLOY_FILE).jobs[job!].steps[Number(index)];
    const env = step.env ?? {};
    const version = env.FLYCTL_VERSION;
    expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(env.FLYCTL_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(env.FLY_API_TOKEN).toBe("${{ secrets.FLY_API_TOKEN }}");
    // GitHub runs `shell: bash` as below. The script must read its inputs
    // from env, since this test cannot expand ${{ }}.
    expect(step.shell).toBe("bash");
    expect(typeof step.run).toBe("string");
    expect(step.run).not.toContain("${{");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pins-"));
    try {
      // A stand-in release: its flyctl records that it ran and with what.
      const release = path.join(tmp, "release");
      fs.mkdirSync(release);
      fs.writeFileSync(
        path.join(release, "flyctl"),
        '#!/bin/sh\nprintf "%s" "$*" > "$FLYCTL_RAN"\n',
        { mode: 0o755 },
      );
      const tarball = path.join(tmp, "flyctl.tar.gz");
      const tar = spawnSync("tar", ["-czf", tarball, "-C", release, "flyctl"], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        encoding: "utf8",
      });
      expect(tar.stderr).toBe("");

      // curl serves the stand-in for any URL and logs what it was asked for.
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "curl"),
        [
          "#!/bin/sh",
          'out=""',
          'while [ $# -gt 0 ]; do case "$1" in',
          '  -o) out="$2"; shift 2 ;;',
          "  -*) shift ;;",
          '  *) printf "%s\\n" "$1" >> "$CURL_LOG"; shift ;;',
          "esac; done",
          'cp "$FAKE_RELEASE" "$out"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const script = path.join(tmp, "step.sh");
      fs.writeFileSync(script, step.run as string);

      function runStep(hash: string) {
        const runnerTemp = fs.mkdtempSync(path.join(tmp, "runner-"));
        const ran = path.join(runnerTemp, "flyctl-ran");
        const curlLog = path.join(runnerTemp, "curl.log");
        const stepEnv = Object.fromEntries(
          Object.entries(env).map(([key, value]) => [
            key,
            String(value).includes("${{") ? `test-${key}` : String(value),
          ]),
        );
        // System dirs only, so no flyctl on the developer's PATH can run.
        const run = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-eo", "pipefail", script],
          {
            cwd: runnerTemp,
            encoding: "utf8",
            env: {
              ...stepEnv,
              FLYCTL_SHA256: hash,
              PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
              HOME: runnerTemp,
              RUNNER_TEMP: runnerTemp,
              FAKE_RELEASE: tarball,
              CURL_LOG: curlLog,
              FLYCTL_RAN: ran,
            },
          },
        );
        return {
          status: run.status,
          stderr: run.stderr,
          urls: fs.existsSync(curlLog)
            ? fs.readFileSync(curlLog, "utf8").trim().split("\n")
            : [],
          flyctl: fs.existsSync(ran) ? fs.readFileSync(ran, "utf8") : null,
        };
      }

      // The committed hash does not match the stand-in, as for a replaced
      // release asset: the step fails and flyctl never runs.
      const replaced = runStep(env.FLYCTL_SHA256 as string);
      expect(replaced).toMatchObject({
        urls: [
          `https://github.com/superfly/flyctl/releases/download/v${version}/flyctl_${version}_Linux_x86_64.tar.gz`,
        ],
        flyctl: null,
      });
      expect(replaced.status).not.toBe(0);

      // With the stand-in's own hash the same script deploys, so the failure
      // above came from the hash check.
      expect(runStep(sha256(tarball))).toMatchObject({
        status: 0,
        flyctl: expect.stringMatching(/^deploy /),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pins every external Dockerfile image by digest but the base stage", () => {
    // The base stage tracks its Node LTS tag on purpose, and
    // scripts/node-runtime.mts holds its form. A stage name such as
    // `FROM base` pulls nothing.
    const loose: string[] = [];
    const dockerfiles = fs
      .readdirSync(repoRoot)
      .filter((name) => /^Dockerfile|\.Dockerfile$/.test(name));
    expect(dockerfiles).toContain("Dockerfile");
    for (const name of dockerfiles) {
      const stages = new Set<string>(["scratch"]);
      const lines = fs
        .readFileSync(path.join(repoRoot, name), "utf8")
        .split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        const from =
          /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
        if (!from) continue;
        const image = from[1]!;
        const stage = from[2]?.toLowerCase();
        const pinned = /@sha256:[0-9a-f]{64}$/.test(image);
        if (!stages.has(image.toLowerCase()) && !pinned && stage !== "base") {
          loose.push(`${name}:${i + 1} ${line.trim()}`);
        }
        if (stage) stages.add(stage);
      }
    }
    expect(loose).toEqual([]);
  });
});
