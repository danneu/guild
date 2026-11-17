import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getClient, pool } from "./util";

// Intent: a pg connection whose socket dies never exits the process, whether
// the pool holds it idle, a transaction has it checked out, or it is a
// dedicated client.
// Why it exists: pg emits 'error' when a socket dies, and an 'error' with no
// listener throws. pg-pool takes its own listener off a client at checkout, so
// a database failover during any transaction exited the web process (hunt
// 261117-0852-024).
// Scenario: the pool hands out a client (only the socket connect is stubbed),
// the client errors while checked out, and again once it is back in the pool.

function dead() {
  return new Error("Connection terminated unexpectedly");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  await pool.end();
});

describe("db/util", () => {
  it("survives a pooled client's error, checked out or idle", async () => {
    const connect = vi
      .spyOn(pg.Client.prototype, "connect")
      .mockImplementation(function (callback?: (err: Error) => void) {
        callback?.(undefined as unknown as Error);
      } as typeof pg.Client.prototype.connect);
    const client = await pool.connect();
    connect.mockRestore();

    expect(() => client.emit("error", dead())).not.toThrow();
    client.release();
    expect(() => client.emit("error", dead())).not.toThrow();
  });

  it("hands every error of a dedicated client to its owner", () => {
    const onError = vi.fn();
    const client = getClient(onError);
    const err = dead();

    client.emit("error", err);

    expect(onError).toHaveBeenCalledWith(err);
  });
});
