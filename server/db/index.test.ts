import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "./util";
import { replacePasswordTx, updateUserActiveTrophyId } from "./index";

// The repo has no real-database tests, so these pin the SQL text and the
// bound params each write sends.
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  pool: { query: vi.fn() },
}));

// server/bbcode.js loads cache3 with a CommonJS require that vitest cannot
// resolve to a .ts file. Nothing tested here renders markup.
vi.mock("../bbcode", () => ({ default: vi.fn() }));

const query = vi.mocked(pool.query) as any;

function lastCall(): [string, unknown[] | undefined] {
  const call = query.mock.calls.at(-1);
  return [call[0], call[1]];
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("updateUserActiveTrophyId", () => {
  const userId = 7;
  const trophyId = 3;

  // Intent: the write itself refuses a trophy the user was never awarded.
  // Why it exists: the rule used to live in a separate lookup at the one
  // callsite, so a route that skipped it could set any trophy on any user.
  it("only sets a trophy the user holds", async () => {
    await updateUserActiveTrophyId(userId, trophyId);

    const [sql, params] = lastCall();
    expect(sql).toMatch(/SET active_trophy_id = \$2\s+WHERE id = \$1\s+AND/);
    expect(sql).toMatch(
      /EXISTS \(\s*SELECT 1\s+FROM trophies_users\s+WHERE user_id = \$1\s+AND trophy_id = \$2\s*\)/,
    );
    expect(params).toEqual([userId, trophyId]);
  });

  it("reports whether a row changed", async () => {
    await expect(updateUserActiveTrophyId(userId, trophyId)).resolves.toBe(
      true,
    );

    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(updateUserActiveTrophyId(userId, trophyId)).resolves.toBe(
      false,
    );
  });
});

describe("replacePasswordTx", () => {
  const userId = 42;
  const digest = "$2a$10$new-digest";
  const newSession = { id: "0190e3a0-0000-7000-8000-0000000000aa" };

  // Answers by SQL text, so the test pins which statements run, not how many.
  function makePgClient() {
    const clientQuery = vi.fn(async (sql: string, _params?: unknown[]) =>
      /INSERT INTO sessions/.test(sql) ? { rows: [newSession] } : { rows: [] },
    );
    return { _inTransaction: true, query: clientQuery } as any;
  }

  // Intent: replacing a password revokes every grant the old credential gave
  // before it issues the one new session.
  // Why it exists: hunt finding 261026-0911-013. A reset left an intruder's
  // sessions (up to a year with remember-me) and a staged email-change link
  // alive, so the owner could not lock them out.
  // Scenario: user 42 resets. All of the user's sessions, reset tokens and
  // staged email links are deleted, then the new session is inserted.
  it("revokes sessions, reset tokens and staged email links before the new session", async () => {
    const pgClient = makePgClient();

    const session = await replacePasswordTx(pgClient, userId, digest, {
      ipAddress: "203.0.113.7",
      interval: "1 day",
    });

    expect(session).toBe(newSession);
    // A write sent to the pool would escape the transaction.
    expect(query).not.toHaveBeenCalled();

    const calls: [string, unknown[]][] = pgClient.query.mock.calls;
    expect(calls).toContainEqual([
      expect.stringMatching(/UPDATE users\s+SET digest = \$1/),
      [digest, userId],
    ]);

    const insertAt = calls.findIndex(([sql]) =>
      /INSERT INTO sessions/.test(sql),
    );
    expect(insertAt).toBeGreaterThanOrEqual(0);

    for (const table of [
      "sessions",
      "reset_tokens",
      "email_verification_tokens",
    ]) {
      // Keyed on the user alone: an extra condition would spare some rows.
      const revoke = new RegExp(
        `DELETE FROM ${table}\\s+WHERE user_id = \\$1\\s*$`,
      );
      const at = calls.findIndex(
        ([sql, params]) =>
          revoke.test(sql) &&
          JSON.stringify(params) === JSON.stringify([userId]),
      );
      expect(at, `DELETE FROM ${table} for the user`).toBeGreaterThanOrEqual(0);
      expect(at, `DELETE FROM ${table} before the new session`).toBeLessThan(
        insertAt,
      );
    }
  });
});
