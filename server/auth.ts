// The one owner of password hashing and checking. A login check here never
// shows whether an account exists, and the password-owner test in
// server/auth.test.ts fails if any other module imports bcrypt. It also owns
// the login attempt budget, so no password check can skip it.
//
// It imports nothing from server/db: db imports hashPassword from here, so
// authenticate takes its account lookup and its attempt store as arguments.

import bcrypt from "bcryptjs";
import { slugifyUname } from "./belt";

// Work factor for every new digest. Remake DUMMY_DIGEST when it changes;
// server/auth.test.ts fails until the two match.
export const BCRYPT_COST = 10;

// A whole digest made at BCRYPT_COST from a random string nobody kept. When no
// account matches, authenticate compares against it so the miss does the same
// bcrypt work as a wrong password. Remake it with
// bcrypt.hashSync(crypto.randomUUID(), BCRYPT_COST).
const DUMMY_DIGEST =
  "$2b$10$yoc0IPFYUtG7v1pZW5Hg0uYiVPrU0iUdcQtp4ZF6Scf0JMR7B1xZS";

// The longest email address there can be. No account matches a longer
// identifier, so refusing one early shows nothing about any account.
const MAX_IDENTIFIER_LENGTH = 254;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

// The login attempt budget. Each typed identifier and each client network has
// its own counter of attempts admitted in its current window. A window starts
// at the first attempt admitted after the previous one ended.
export type LoginLimits = {
  windowSeconds: number;
  // Attempts per identifier per window that need no challenge.
  identifierSoft: number;
  // Attempts per identifier per window, solved challenge or not.
  identifierHard: number;
  // Attempts per network per window that need no challenge. A network has no
  // hard cap: a busy shared network gets a challenge, never a lockout.
  ipSoft: number;
};

// First guesses, meant to be tuned.
export const LOGIN_LIMITS: LoginLimits = {
  windowSeconds: 60 * 60,
  identifierSoft: 5,
  identifierHard: 15,
  ipSoft: 30,
};

// What a charge decided. The store charges both counters only for ADMIT.
export type Admission = "ADMIT" | "CHALLENGE_REQUIRED" | "THROTTLED";

export type AttemptCounts = { identifier: number; ip: number };

// Durable attempt counters. server/db/login_attempts.ts keeps them in Postgres,
// so they survive deploys and are shared across machines.
export type AttemptStore = {
  // In one transaction: lock the identifier's and the network's counters, pass
  // their counts in the current window to decide, and add one to both only
  // when it returns ADMIT.
  charge(
    keys: { identifier: string; ip: string },
    windowSeconds: number,
    decide: (counts: AttemptCounts) => Admission,
  ): Promise<Admission>;
};

// Asks the challenge provider whether a token is a fresh solve from this ip.
export type ChallengeVerifier = (token: string, ip: string) => Promise<boolean>;

export type AuthResult<User> =
  | { type: "OK"; user: User }
  | { type: "INVALID" }
  | { type: "CHALLENGE_REQUIRED" }
  | { type: "THROTTLED" };

// Checks a login. Without the right password, neither the answer nor the work
// may depend on whether the identifier matches an account. So the budget is
// charged before the lookup, keyed on what was typed, and past it each call
// runs one bcrypt compare and every failure is the same INVALID.
//
// verifyChallenge is null when no challenge provider is configured. Then a
// request over either soft limit is THROTTLED: the budget fails closed.
export async function authenticate<User extends { digest: string }>(
  deps: {
    findUser: (identifier: string) => Promise<User | undefined>;
    attempts: AttemptStore;
    verifyChallenge: ChallengeVerifier | null;
  },
  input: {
    identifier: string;
    password: string;
    ip: string;
    challengeToken?: string | undefined;
  },
  limits: LoginLimits = LOGIN_LIMITS,
): Promise<AuthResult<User>> {
  if (input.identifier.length > MAX_IDENTIFIER_LENGTH) {
    return { type: "INVALID" };
  }
  // Verified before the charge, so the store never holds its row locks across
  // a network call.
  const solved = await isChallengeSolved(deps.verifyChallenge, input);
  const admission = await deps.attempts.charge(
    // The slug form, so case and spaces share one budget.
    { identifier: slugifyUname(input.identifier), ip: input.ip },
    limits.windowSeconds,
    (counts) =>
      decideAdmission(counts, {
        solved,
        canChallenge: deps.verifyChallenge !== null,
        limits,
      }),
  );
  if (admission !== "ADMIT") {
    return { type: admission };
  }

  const user = await deps.findUser(input.identifier);
  const matches = await bcrypt.compare(
    input.password,
    user?.digest ?? DUMMY_DIGEST,
  );
  return user && matches ? { type: "OK", user } : { type: "INVALID" };
}

// The admission rule. It reads only the two counts and the challenge, never
// the account. A refusal is not charged, so a tokenless trickle cannot push a
// name toward its hard cap.
function decideAdmission(
  counts: AttemptCounts,
  challenge: { solved: boolean; canChallenge: boolean; limits: LoginLimits },
): Admission {
  const { solved, canChallenge, limits } = challenge;
  const identifierAdmits =
    counts.identifier < limits.identifierSoft ||
    (solved && counts.identifier < limits.identifierHard);
  const ipAdmits = counts.ip < limits.ipSoft || solved;
  if (identifierAdmits && ipAdmits) {
    return "ADMIT";
  }
  if (!canChallenge || counts.identifier >= limits.identifierHard) {
    return "THROTTLED";
  }
  return "CHALLENGE_REQUIRED";
}

// A provider outage counts as unsolved rather than failing the request, so it
// blocks only the logins that are over a soft limit.
async function isChallengeSolved(
  verify: ChallengeVerifier | null,
  input: { ip: string; challengeToken?: string | undefined },
): Promise<boolean> {
  if (verify === null || !input.challengeToken) {
    return false;
  }
  try {
    return await verify(input.challengeToken, input.ip);
  } catch (err) {
    console.error("auth: challenge verification failed:", err);
    return false;
  }
}
