import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "./util";
import { updateUserActiveTrophyId } from "./index";

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
