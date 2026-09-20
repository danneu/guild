import { describe, expect, it, vi } from "vitest";

import {
  consumeEmailVerificationTokenTx,
  deleteEmailVerificationTokenByToken,
  EmailTakenError,
} from "./email_verification";

const TOKEN = "0190e3a0-0000-7000-8000-000000000001";

function makePgClient(deleteRows: unknown[], updateResult?: Error) {
  const query = vi.fn().mockResolvedValueOnce({ rows: deleteRows });
  if (updateResult) {
    query.mockRejectedValueOnce(updateResult);
  } else {
    query.mockResolvedValueOnce({ rows: [] });
  }
  return { _inTransaction: true, query } as any;
}

function uniqueEmailViolation() {
  const err: any = new Error(
    'duplicate key value violates unique constraint "unique_email"',
  );
  err.code = "23505";
  return err;
}

describe("consumeEmailVerificationTokenTx", () => {
  it("resolves INVALID and never issues the UPDATE when no token row matches", async () => {
    const pgClient = makePgClient([]);

    await expect(
      consumeEmailVerificationTokenTx(pgClient, TOKEN),
    ).resolves.toEqual({ type: "INVALID" });

    // The DELETE is the only statement: a double-clicked link cannot re-verify.
    expect(pgClient.query).toHaveBeenCalledTimes(1);
  });

  it("only consumes tokens that have not expired", async () => {
    const pgClient = makePgClient([]);

    await consumeEmailVerificationTokenTx(pgClient, TOKEN);

    expect(pgClient.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("expired_at"),
      [TOKEN],
    );
  });

  it("verifies the address the DELETE returned, not any other staged address", async () => {
    const pgClient = makePgClient([{ user_id: 42, email: "from-token@x.com" }]);

    await expect(
      consumeEmailVerificationTokenTx(pgClient, TOKEN),
    ).resolves.toEqual({
      type: "OK",
      userId: 42,
      email: "from-token@x.com",
    });

    expect(pgClient.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE users"),
      ["from-token@x.com", 42],
    );
  });

  it("rejects rather than resolves when the address was claimed meanwhile", async () => {
    const pgClient = makePgClient(
      [{ user_id: 42, email: "taken@x.com" }],
      uniqueEmailViolation(),
    );

    // Must throw: withPgPoolTransaction rolls back only on a throw, and a
    // returned error value would commit an already-aborted transaction.
    await expect(
      consumeEmailVerificationTokenTx(pgClient, TOKEN),
    ).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("propagates unrelated database errors", async () => {
    const boom = new Error("connection reset");
    const pgClient = makePgClient([{ user_id: 42, email: "x@x.com" }], boom);

    await expect(consumeEmailVerificationTokenTx(pgClient, TOKEN)).rejects.toBe(
      boom,
    );
  });
});

describe("deleteEmailVerificationTokenByToken", () => {
  it("keys the collision cleanup on the token value, not the user", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };

    await deleteEmailVerificationTokenByToken(db, TOKEN);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE token = $1"),
      [TOKEN],
    );
  });
});
