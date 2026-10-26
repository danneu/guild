// The one owner of password hashing and checking. A login check here never
// shows whether an account exists, and the password-owner test in
// server/auth.test.ts fails if any other module imports bcrypt.
//
// It imports nothing from server/db: db imports hashPassword from here, so
// authenticate takes its account lookup as an argument instead.

import bcrypt from "bcryptjs";

// Work factor for every new digest. Remake DUMMY_DIGEST when it changes;
// server/auth.test.ts fails until the two match.
export const BCRYPT_COST = 10;

// A whole digest made at BCRYPT_COST from a random string nobody kept. When no
// account matches, authenticate compares against it so the miss does the same
// bcrypt work as a wrong password. Remake it with
// bcrypt.hashSync(crypto.randomUUID(), BCRYPT_COST).
const DUMMY_DIGEST =
  "$2b$10$yoc0IPFYUtG7v1pZW5Hg0uYiVPrU0iUdcQtp4ZF6Scf0JMR7B1xZS";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export type AuthResult<User> = { type: "OK"; user: User } | { type: "INVALID" };

// Checks a login. Without the right password, neither the answer nor the work
// may depend on whether the identifier matches an account: each call runs one
// bcrypt compare, and every failure is the same INVALID.
export async function authenticate<User extends { digest: string }>(
  deps: { findUser: (identifier: string) => Promise<User | undefined> },
  input: { identifier: string; password: string },
): Promise<AuthResult<User>> {
  const user = await deps.findUser(input.identifier);
  const matches = await bcrypt.compare(
    input.password,
    user?.digest ?? DUMMY_DIGEST,
  );
  return user && matches ? { type: "OK", user } : { type: "INVALID" };
}
