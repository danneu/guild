import { describe, expect, it, vi } from "vitest";

import { pool } from "./util";
import { changeUname } from "./unames";

vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  pool: { query: vi.fn(), withTransaction: vi.fn() },
}));

// The database clock
const T0 = new Date("2026-11-17T12:00:00Z");

// A client in a transaction whose newest name change was at lastChangeAt.
// The new name is free, and the account never held it.
function unames(lastChangeAt: Date | null) {
  function answer(sql: string): unknown[] {
    if (/pg_advisory_xact_lock/.test(sql)) return [{}];
    if (/clock_timestamp\(\)/.test(sql)) {
      return [{ now: T0, last_change_at: lastChangeAt }];
    }
    if (/UPDATE users/.test(sql)) {
      return [{ id: 7, uname: "New Name", slug: "new-name" }];
    }
    return [];
  }
  const client = {
    _inTransaction: true,
    query: vi.fn(async (sql: string) => {
      const rows = answer(sql);
      return { rows, rowCount: rows.length };
    }),
  } as any;
  vi.mocked(pool.withTransaction).mockImplementation(async (fn: any) =>
    fn(client),
  );
  return client;
}

function writes(client: any): string[] {
  return client.query.mock.calls
    .map(([sql]: [string]) => sql)
    .filter((sql: string) => /INSERT|UPDATE/.test(sql));
}

const change = {
  userId: 7,
  changedById: 7,
  oldUname: "Old Name",
  newUname: "New Name",
};

// Intent: a member changes their name at most once every 3 months, by the
// database clock, and the check runs in the write's transaction.
// Why it exists: hunt finding 261117-0852-031. The check read the newest
// change with no lock, so a burst of renames all passed it, and each name it
// left behind stayed reserved from everyone else.
describe("changeUname", () => {
  it("refuses a change 3 months after the last, less 1 ms", async () => {
    const client = unames(new Date("2026-08-17T12:00:00.001Z"));

    await expect(changeUname(change)).resolves.toEqual({
      type: "RATE_LIMITED",
    });
    expect(writes(client)).toEqual([]);
  });

  it("changes the name 3 months after the last", async () => {
    unames(new Date("2026-08-17T12:00:00Z"));

    await expect(changeUname(change)).resolves.toMatchObject({
      type: "SUCCESS",
      user: { uname: "New Name" },
    });
  });
});
