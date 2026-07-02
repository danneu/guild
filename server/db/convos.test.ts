import { describe, expect, it, vi } from "vitest";

import { isFirstStartedConvo } from "./convos";

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

  it("locks the user row before checking started convos", async () => {
    const pgClient = makePgClient([]);

    await isFirstStartedConvo(pgClient, 42);

    expect(pgClient.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FOR UPDATE"),
      [42],
    );
    expect(pgClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM convos"),
      [42],
    );
  });
});
