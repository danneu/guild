import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticate, BCRYPT_COST } from "./auth";

// Cost 4 keeps the fake account cheap, and its digest cannot pass for the
// dummy the unknown path must compare against.
const PASSWORD = "correct horse";
const alice = { id: 1, uname: "alice", digest: bcrypt.hashSync(PASSWORD, 4) };
const deps = {
  findUser: async (identifier: string) =>
    identifier === "alice@example.com" ? alice : undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticate", () => {
  // Intent: without the right password, an unknown identifier gets the same
  // answer and the same bcrypt work as a known one.
  // Why it exists: POST /sessions answered "Invalid creds (3)" for an unknown
  // uname or email and "Invalid creds (4)" for a wrong password, and skipped
  // bcrypt for the unknown one, so anyone could learn whether an email has an
  // account (hunt finding 261026-0911-012).
  // Scenario: a stranger tries nobody@example.com, then alice@example.com,
  // with the same wrong password.
  it("answers an unknown identifier exactly as it answers a wrong password", async () => {
    const compare = vi.spyOn(bcrypt, "compare");

    const unknown = await authenticate(deps, {
      identifier: "nobody@example.com",
      password: "guess",
    });
    const wrong = await authenticate(deps, {
      identifier: "alice@example.com",
      password: "guess",
    });

    expect(unknown).toEqual(wrong);
    expect(compare).toHaveBeenCalledTimes(2);
    const [unknownCall, wrongCall] = compare.mock.calls;
    expect(wrongCall).toEqual(["guess", alice.digest]);
    // bcryptjs answers false at once, without hashing, for a digest of the
    // wrong length, so the unknown path must use a whole digest at full cost.
    expect(unknownCall?.[0]).toBe("guess");
    const dummy = unknownCall?.[1] ?? "";
    expect(dummy).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    expect(bcrypt.getRounds(dummy)).toBe(BCRYPT_COST);
  });

  it("logs in with the right password", async () => {
    await expect(
      authenticate(deps, {
        identifier: "alice@example.com",
        password: PASSWORD,
      }),
    ).resolves.toEqual({ type: "OK", user: alice });
  });
});

// Intent: server/auth.ts is the only code that hashes or compares a password.
// Why it exists: authenticate holds the rule that a login check never shows
// whether an account exists. A route that imports bcrypt and compares on its
// own would skip that rule.
// Scenario: a new API login or re-auth prompt calls bcrypt.compare directly.
describe("password owner", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const exempt = new Set(["server/auth.test.ts"]);

  function sourceFiles(): string[] {
    return ["server", "scripts"].flatMap((dir) =>
      fs
        .readdirSync(path.join(repoRoot, dir), {
          recursive: true,
          encoding: "utf8",
        })
        .filter((file) => /\.(ts|js)$/.test(file))
        .map((file) => path.join(dir, file).split(path.sep).join("/"))
        .filter((file) => !exempt.has(file))
        .sort(),
    );
  }

  // Matches import, export-from, side-effect import, dynamic import() and
  // require() of any bcrypt package or a path inside it.
  const importsBcrypt =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]bcrypt[^"'`]*["'`]/;

  it("only server/auth.ts imports bcrypt", () => {
    const importers = sourceFiles().filter((file) =>
      importsBcrypt.test(fs.readFileSync(path.join(repoRoot, file), "utf8")),
    );
    expect(importers).toEqual(["server/auth.ts"]);
  });
});
