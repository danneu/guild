import { describe, expect, it, vi } from "vitest";

import { chargeTx } from "./login_attempts";

const KEYS = { identifier: "alice", ip: "203.0.113.7" };

function makePgClient(lockRows: unknown[]) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: lockRows })
    .mockResolvedValueOnce({ rows: [] });
  return { _inTransaction: true, query } as any;
}

describe("chargeTx", () => {
  // The owner's tests use an in-memory store, so this pins that the Postgres
  // one also leaves a refused request uncharged.
  it("hands decide each counter's count and charges nothing on a refusal", async () => {
    const pgClient = makePgClient([
      { kind: "ip", count: 9 },
      { kind: "identifier", count: 5 },
    ]);
    const decide = vi.fn().mockReturnValue("CHALLENGE_REQUIRED");

    await expect(chargeTx(pgClient, KEYS, 3600, decide)).resolves.toBe(
      "CHALLENGE_REQUIRED",
    );

    expect(decide).toHaveBeenCalledWith({ identifier: 5, ip: 9 });
    // The locking upsert is the only statement.
    expect(pgClient.query).toHaveBeenCalledTimes(1);
  });

  it("charges both counters on ADMIT", async () => {
    const pgClient = makePgClient([
      { kind: "identifier", count: 0 },
      { kind: "ip", count: 0 },
    ]);

    await expect(chargeTx(pgClient, KEYS, 3600, () => "ADMIT")).resolves.toBe(
      "ADMIT",
    );

    expect(pgClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE login_attempts"),
      ["alice", "203.0.113.7", 3600],
    );
  });
});
