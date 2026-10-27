import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticate,
  BCRYPT_COST,
  type Admission,
  type AttemptCounts,
  type AttemptStore,
} from "./auth";

// Cost 4 keeps the fake account cheap, and its digest cannot pass for the
// dummy the unknown path must compare against.
const PASSWORD = "correct horse";
const alice = { id: 1, uname: "alice", digest: bcrypt.hashSync(PASSWORD, 4) };
async function findUser(identifier: string) {
  return identifier === "alice@example.com" ? alice : undefined;
}
const IP = "203.0.113.7";

// Small limits keep each test to a few bcrypt compares.
const LIMITS = {
  windowSeconds: 3600,
  identifierSoft: 2,
  identifierHard: 4,
  ipSoft: 100,
};

// An in-memory attempt store. It applies the owner's decision exactly as the
// Postgres store does: it charges both counters only when the decision is ADMIT.
function fakeAttempts() {
  const counts = new Map<string, number>();
  const store: AttemptStore = {
    async charge(
      keys: { identifier: string; ip: string },
      _windowSeconds: number,
      decide: (counts: AttemptCounts) => Admission,
    ) {
      const identifierKey = `identifier:${keys.identifier}`;
      const ipKey = `ip:${keys.ip}`;
      const verdict = decide({
        identifier: counts.get(identifierKey) ?? 0,
        ip: counts.get(ipKey) ?? 0,
      });
      if (verdict === "ADMIT") {
        counts.set(identifierKey, (counts.get(identifierKey) ?? 0) + 1);
        counts.set(ipKey, (counts.get(ipKey) ?? 0) + 1);
      }
      return verdict;
    },
  };
  return { store, counts };
}

// The budget tests care only about whether the compare runs, not its answer.
function stubCompare() {
  return vi.spyOn(bcrypt, "compare").mockImplementation(async () => false);
}

async function solved() {
  return true;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticate", () => {
  // A fresh store under the default limits never refuses one or two attempts.
  function openDeps() {
    return { findUser, attempts: fakeAttempts().store, verifyChallenge: null };
  }

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

    const unknown = await authenticate(openDeps(), {
      identifier: "nobody@example.com",
      password: "guess",
      ip: IP,
    });
    const wrong = await authenticate(openDeps(), {
      identifier: "alice@example.com",
      password: "guess",
      ip: IP,
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
      authenticate(openDeps(), {
        identifier: "alice@example.com",
        password: PASSWORD,
        ip: IP,
      }),
    ).resolves.toEqual({ type: "OK", user: alice });
  });
});

describe("login attempt budget", () => {
  // Intent: once an identifier has used its free attempts, a request without a
  // solved challenge is refused before any account lookup or bcrypt compare,
  // and the refusal is not charged.
  // Why it exists: POST /sessions ran a bcrypt compare on every request with no
  // limit, so anyone could guess the password of any public uname without
  // bound (hunt finding 261026-0911-011).
  // Scenario: a script sends wrong passwords for alice with no Turnstile token.
  it("refuses a tokenless attempt over the soft limit before the lookup and the compare", async () => {
    const compare = stubCompare();
    const lookup = vi.fn(findUser);
    const attempts = fakeAttempts();
    function login() {
      return authenticate(
        { findUser: lookup, attempts: attempts.store, verifyChallenge: solved },
        { identifier: "alice@example.com", password: "guess", ip: IP },
        LIMITS,
      );
    }

    for (let i = 0; i < LIMITS.identifierSoft; i++) {
      expect(await login()).toEqual({ type: "INVALID" });
    }
    lookup.mockClear();
    compare.mockClear();

    expect(await login()).toEqual({ type: "CHALLENGE_REQUIRED" });
    expect(await login()).toEqual({ type: "CHALLENGE_REQUIRED" });
    expect(lookup).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
    // A refusal is not charged, so a tokenless trickle cannot push a name
    // toward the hard cap.
    expect(attempts.counts.get("identifier:alice@example.com")).toBe(
      LIMITS.identifierSoft,
    );
  });

  // Intent: the budget's answers never show whether an account exists.
  // Why it exists: a throttle keyed on the account, or one that only real
  // names reach, would reopen the leak hunt finding 261026-0911-012 closed.
  // Scenario: the same run of wrong guesses, with and without solved
  // challenges, against a real email and an unknown one.
  it("gives an unknown identifier the same results as a known one", async () => {
    stubCompare();
    async function run(identifier: string) {
      const attempts = fakeAttempts();
      const results: string[] = [];
      for (const challengeToken of [
        undefined,
        undefined,
        undefined,
        "token",
        "token",
        "token",
        undefined,
      ]) {
        const result = await authenticate(
          { findUser, attempts: attempts.store, verifyChallenge: solved },
          { identifier, password: "guess", ip: IP, challengeToken },
          LIMITS,
        );
        results.push(result.type);
      }
      return results;
    }

    const known = await run("alice@example.com");
    expect(await run("nobody@example.com")).toEqual(known);
    expect(known).toEqual([
      "INVALID",
      "INVALID",
      "CHALLENGE_REQUIRED",
      "INVALID",
      "INVALID",
      "THROTTLED",
      "THROTTLED",
    ]);
  });

  it("throttles over either soft limit when no challenge is configured", async () => {
    stubCompare();
    const attempts = fakeAttempts();
    function login(identifier: string) {
      return authenticate(
        { findUser, attempts: attempts.store, verifyChallenge: null },
        { identifier, password: "guess", ip: IP, challengeToken: "token" },
        { ...LIMITS, ipSoft: 3 },
      );
    }

    expect((await login("alice")).type).toBe("INVALID");
    expect((await login("alice")).type).toBe("INVALID");
    expect((await login("alice")).type).toBe("THROTTLED");
    expect((await login("bob")).type).toBe("INVALID");
    expect((await login("carol")).type).toBe("THROTTLED");
  });

  // Intent: a network over its soft limit gets a challenge, never a lockout.
  // Why it exists: a carrier NAT or campus network adds up ordinary logins,
  // and a hard cap there would lock everyone on it out.
  it("challenges a busy network but never hard-refuses it", async () => {
    stubCompare();
    const attempts = fakeAttempts();
    function login(identifier: string, challengeToken?: string) {
      return authenticate(
        { findUser, attempts: attempts.store, verifyChallenge: solved },
        { identifier, password: "guess", ip: IP, challengeToken },
        { ...LIMITS, ipSoft: 2 },
      );
    }

    expect((await login("u1")).type).toBe("INVALID");
    expect((await login("u2")).type).toBe("INVALID");
    expect((await login("u3")).type).toBe("CHALLENGE_REQUIRED");
    for (const name of ["u3", "u4", "u5", "u6", "u7"]) {
      expect((await login(name, "token")).type).toBe("INVALID");
    }
    expect(attempts.counts.get(`ip:${IP}`)).toBe(7);
  });

  it("counts a refused or failed verification as unsolved", async () => {
    stubCompare();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const verifiers = [
      async () => false,
      async () => {
        throw new Error("Cloudflare is down");
      },
    ];
    for (const verifyChallenge of verifiers) {
      const attempts = fakeAttempts();
      const login = () =>
        authenticate(
          { findUser, attempts: attempts.store, verifyChallenge },
          {
            identifier: "alice",
            password: "guess",
            ip: IP,
            challengeToken: "t",
          },
          LIMITS,
        );
      expect((await login()).type).toBe("INVALID");
      expect((await login()).type).toBe("INVALID");
      expect((await login()).type).toBe("CHALLENGE_REQUIRED");
    }
  });

  // Intent: an identifier no account can have is refused before it becomes a
  // budget key or reaches the lookup.
  // Why it exists: koaBody accepts form bodies of many megabytes, so the field
  // is attacker-sized.
  it("refuses an identifier longer than any email without charging it", async () => {
    const compare = stubCompare();
    const attempts = fakeAttempts();
    const charge = vi.spyOn(attempts.store, "charge");
    function login(identifier: string) {
      return authenticate(
        { findUser, attempts: attempts.store, verifyChallenge: null },
        { identifier, password: "guess", ip: IP },
        LIMITS,
      );
    }

    expect(await login("a".repeat(255))).toEqual({ type: "INVALID" });
    expect(charge).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();

    await login("a".repeat(254));
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("shares one budget across case and spaces", async () => {
    stubCompare();
    const attempts = fakeAttempts();
    function login(identifier: string) {
      return authenticate(
        { findUser, attempts: attempts.store, verifyChallenge: solved },
        { identifier, password: "guess", ip: IP },
        LIMITS,
      );
    }

    await login("Alice Smith");
    await login(" alice smith ");
    expect((await login("ALICE-SMITH")).type).toBe("CHALLENGE_REQUIRED");
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
