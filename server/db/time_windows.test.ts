// Intent: the time windows behind the send budget, the login attempt budget,
// password reset tokens, sessions and email confirmation links hold on real
// rows. Each is tested on both sides of its boundary, in a real Postgres
// (server/testing/db.ts), with rows stamped relative to the database's now().
// Why it exists: the stub tests answer each query by its text and ignore its
// WHERE clause, so a flipped comparison or a dropped user_id filter passed
// every test, while it would let a sender spend without limit or keep an
// expired reset token live (hunt 261117-0852-020).

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "../config";
import { closeTestDatabase, emptyTables } from "../testing/db";
import { consumeEmailVerificationToken } from "./email_verification";
import { findUserByResetToken, findUserBySessionId } from "./index";
import { charge, deleteEndedWindows } from "./login_attempts";
import { SendBudgetExceeded, spend } from "./send_budget";
import { pool } from "./util";

vi.mock("./util", async (importOriginal) =>
  (await import("../testing/db")).onTestDatabase(
    await importOriginal<typeof import("./util")>(),
  ),
);

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest. Nothing here renders markup.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

beforeEach(emptyTables);
afterAll(closeTestDatabase);

const MINUTE = 60;
const TOKEN = "0190e3a0-0000-7000-8000-000000000001";

async function createUser(uname: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO users (uname, digest, email, slug)
    VALUES ($1, '', $1 || '@example.com', $1)
    RETURNING id
  `,
    [uname],
  );
  return rows[0]!.id;
}

describe("send budget", () => {
  // A new member's hourly budget. Each test seeds it as one spend.
  const BUDGET = config.SEND_BUDGET_PER_HOUR_UNTRUSTED;

  async function seedSpend(userId: number, cost: number, ageSeconds: number) {
    await pool.query(
      `
      INSERT INTO send_spends (user_id, cost, created_at)
      VALUES ($1, $2, now() - make_interval(secs => $3))
    `,
      [userId, cost, ageSeconds],
    );
  }

  function send(userId: number) {
    return pool.withTransaction((client) => spend(client, userId, 1));
  }

  it("counts a spend made inside the hour", async () => {
    const alice = await createUser("alice");
    await seedSpend(alice, BUDGET, 59 * MINUTE);

    await expect(send(alice)).rejects.toBeInstanceOf(SendBudgetExceeded);
  });

  it("forgets a spend made over an hour ago and deletes it", async () => {
    const alice = await createUser("alice");
    await seedSpend(alice, BUDGET, 61 * MINUTE);

    await send(alice);

    const { rows } = await pool.query(`SELECT cost FROM send_spends`);
    expect(rows).toEqual([{ cost: 1 }]);
  });

  it("counts only the sender's own spends", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");
    await seedSpend(bob, BUDGET, 59 * MINUTE);

    await send(alice);

    const { rows } = await pool.query(
      `SELECT user_id, cost FROM send_spends ORDER BY user_id`,
    );
    expect(rows).toEqual([
      { user_id: alice, cost: 1 },
      { user_id: bob, cost: BUDGET },
    ]);
  });
});

describe("login attempts", () => {
  const KEYS = { identifier: "alice", ip: "203.0.113.7" };
  const WINDOW_SECONDS = 60 * MINUTE;

  // Makes both counters through a charge, then sets their count and when
  // their window ends.
  async function seedCounters(count: number, endsInSeconds: number) {
    await charge(KEYS, WINDOW_SECONDS, () => "ADMIT");
    await pool.query(
      `
      UPDATE login_attempts
      SET count = $1, window_ends_at = now() + make_interval(secs => $2)
    `,
      [count, endsInSeconds],
    );
  }

  function counters() {
    return pool
      .query<{
        kind: string;
        count: number;
        window_ends_at: Date;
      }>(`SELECT kind, count, window_ends_at FROM login_attempts ORDER BY kind`)
      .then((res) => res.rows);
  }

  it("counts a live window's attempts and adds to it", async () => {
    await seedCounters(3, MINUTE);
    const before = await counters();
    const decide = vi.fn().mockReturnValue("ADMIT");

    await charge(KEYS, WINDOW_SECONDS, decide);

    expect(decide).toHaveBeenCalledWith({ identifier: 3, ip: 3 });
    expect(await counters()).toEqual(
      before.map((row) => ({ ...row, count: 4 })),
    );
  });

  it("counts an ended window as zero and starts a new one", async () => {
    await seedCounters(3, -MINUTE);
    const decide = vi.fn().mockReturnValue("ADMIT");

    await charge(KEYS, WINDOW_SECONDS, decide);

    expect(decide).toHaveBeenCalledWith({ identifier: 0, ip: 0 });
    const { rows } = await pool.query(`
      SELECT kind, count, window_ends_at > now() + interval '59 minutes' AS new
      FROM login_attempts
      ORDER BY kind
    `);
    expect(rows).toEqual([
      { kind: "identifier", count: 1, new: true },
      { kind: "ip", count: 1, new: true },
    ]);
  });

  it("sweeps ended windows and keeps live ones", async () => {
    await pool.query(`
      INSERT INTO login_attempts (kind, key_digest, count, window_ends_at)
      VALUES
        ('identifier', sha256('ended'), 1, now() - interval '1 minute'),
        ('identifier', sha256('live'), 1, now() + interval '1 minute')
    `);

    await deleteEndedWindows();

    const { rows } = await pool.query(`
      SELECT key_digest = sha256('live') AS live FROM login_attempts
    `);
    expect(rows).toEqual([{ live: true }]);
  });
});

describe("password reset tokens", () => {
  async function seedToken(userId: number, expiresInSeconds: number) {
    await pool.query(
      `
      INSERT INTO reset_tokens (user_id, token, expired_at)
      VALUES ($1, $2, now() + make_interval(secs => $3))
    `,
      [userId, TOKEN, expiresInSeconds],
    );
  }

  it("finds the user by a live token", async () => {
    const alice = await createUser("alice");
    await seedToken(alice, MINUTE);

    expect(await findUserByResetToken(TOKEN)).toMatchObject({ id: alice });
  });

  it("finds no one by an expired token", async () => {
    const alice = await createUser("alice");
    await seedToken(alice, -MINUTE);

    expect(await findUserByResetToken(TOKEN)).toBeUndefined();
  });
});

describe("sessions", () => {
  async function seedSession(userId: number, expiresInSeconds: number) {
    await pool.query(
      `
      INSERT INTO sessions (id, user_id, ip_address, expired_at)
      VALUES ($1, $2, '203.0.113.7', now() + make_interval(secs => $3))
    `,
      [TOKEN, userId, expiresInSeconds],
    );
  }

  it("finds the user by a live session", async () => {
    const alice = await createUser("alice");
    await seedSession(alice, MINUTE);

    expect(await findUserBySessionId(TOKEN)).toMatchObject({ id: alice });
  });

  it("finds no one by an expired session", async () => {
    const alice = await createUser("alice");
    await seedSession(alice, -MINUTE);

    expect(await findUserBySessionId(TOKEN)).toBeUndefined();
  });
});

describe("email confirmation links", () => {
  async function seedLink(userId: number, expiresInSeconds: number) {
    await pool.query(
      `
      INSERT INTO email_verification_tokens (user_id, token, email, expired_at)
      VALUES ($1, $2, 'new@example.com', now() + make_interval(secs => $3))
    `,
      [userId, TOKEN, expiresInSeconds],
    );
  }

  function userEmail(userId: number) {
    return pool
      .query(`SELECT email, email_verified_at FROM users WHERE id = $1`, [
        userId,
      ])
      .then((res) => res.rows[0]);
  }

  it("confirms the address on a live link", async () => {
    const alice = await createUser("alice");
    await seedLink(alice, MINUTE);

    await expect(consumeEmailVerificationToken(TOKEN)).resolves.toEqual({
      type: "OK",
      userId: alice,
      email: "new@example.com",
    });
    expect(await userEmail(alice)).toEqual({
      email: "new@example.com",
      email_verified_at: expect.any(Date),
    });
  });

  it("refuses an expired link and changes nothing", async () => {
    const alice = await createUser("alice");
    await seedLink(alice, -MINUTE);

    await expect(consumeEmailVerificationToken(TOKEN)).resolves.toEqual({
      type: "INVALID",
    });
    expect(await userEmail(alice)).toEqual({
      email: "alice@example.com",
      email_verified_at: null,
    });
  });
});
