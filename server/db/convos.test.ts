import { describe, expect, it, vi } from "vitest";

import { isFirstStartedConvo } from "./convos";
import { LOCK_SPACE } from "./send_budget";

function makePgClient(rows: unknown[]) {
  return {
    _inTransaction: true,
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows }),
  } as any;
}

describe("isFirstStartedConvo", () => {
  it("returns true when the user has not started a convo", async () => {
    const pgClient = makePgClient([]);

    await expect(isFirstStartedConvo(pgClient, 42)).resolves.toBe(true);

    expect(pgClient.query).toHaveBeenCalledTimes(2);
  });

  it("returns false when the user has already started a convo", async () => {
    const pgClient = makePgClient([{}]);

    await expect(isFirstStartedConvo(pgClient, 42)).resolves.toBe(false);

    expect(pgClient.query).toHaveBeenCalledTimes(2);
  });

  // The convo's send takes the send lock next. Locking the users row here
  // instead would let a concurrent send by the same member, which holds the
  // send lock and then writes this row in a trigger, deadlock against it.
  it("takes the send lock before checking started convos", async () => {
    const pgClient = makePgClient([]);

    await isFirstStartedConvo(pgClient, 42);

    expect(pgClient.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("pg_advisory_xact_lock"),
      [LOCK_SPACE, 42],
    );
    expect(pgClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM convos"),
      [42],
    );
  });
});
