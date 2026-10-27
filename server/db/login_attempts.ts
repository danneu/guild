// The Postgres attempt store behind server/auth.ts#authenticate, and the sweep
// that deletes ended windows. The admission rule and the limits live in
// server/auth.ts; this file only locks, counts and charges.
//
// Both keys are hashed in SQL, so every row is fixed size and none holds what
// was typed. The network key is the client's ip_root, the same grouping as
// server/db/ratelimits.ts.

import assert from "assert";
import type { Admission, AttemptCounts } from "../auth";
import { pool, PgClientInTransaction, withPgPoolTransaction } from "./util";

// Upserts both counters, which locks them until the transaction ends. VALUES
// lists the identifier first, so every charge locks in the same order. A new
// row starts with an ended window, and an ended window counts as zero.
const LOCK_SQL = `
  INSERT INTO login_attempts AS a (kind, key_digest, count, window_ends_at)
  VALUES
    ('identifier', sha256(convert_to($1::text, 'UTF8')), 0, now()),
    ('ip', sha256(convert_to(host(ip_root($2::inet)), 'UTF8')), 0, now())
  ON CONFLICT (kind, key_digest) DO UPDATE SET count = a.count
  RETURNING
    a.kind,
    CASE WHEN a.window_ends_at > now() THEN a.count ELSE 0 END AS count
`;

// Adds one to both counters, starting a new window on any that has ended.
const CHARGE_SQL = `
  UPDATE login_attempts SET
    count = CASE WHEN window_ends_at > now() THEN count + 1 ELSE 1 END,
    window_ends_at = CASE
      WHEN window_ends_at > now() THEN window_ends_at
      ELSE now() + make_interval(secs => $3)
    END
  WHERE (kind, key_digest) IN (
    ('identifier', sha256(convert_to($1::text, 'UTF8'))),
    ('ip', sha256(convert_to(host(ip_root($2::inet)), 'UTF8')))
  )
`;

export function charge(
  keys: { identifier: string; ip: string },
  windowSeconds: number,
  decide: (counts: AttemptCounts) => Admission,
): Promise<Admission> {
  return withPgPoolTransaction(pool, (pgClient) =>
    chargeTx(pgClient, keys, windowSeconds, decide),
  );
}

// The body of charge, split out so a test can drive it with a stub client.
export async function chargeTx(
  pgClient: PgClientInTransaction,
  keys: { identifier: string; ip: string },
  windowSeconds: number,
  decide: (counts: AttemptCounts) => Admission,
): Promise<Admission> {
  assert(pgClient._inTransaction, "chargeTx must run in a transaction");
  assert(Number.isInteger(windowSeconds) && windowSeconds > 0);

  const { rows } = await pgClient.query<{
    kind: "identifier" | "ip";
    count: number;
  }>(LOCK_SQL, [keys.identifier, keys.ip]);
  const countOf = (kind: "identifier" | "ip") => {
    const row = rows.find((r) => r.kind === kind);
    assert(row, `login_attempts: no ${kind} counter came back`);
    return row.count;
  };

  const admission = decide({
    identifier: countOf("identifier"),
    ip: countOf("ip"),
  });
  if (admission === "ADMIT") {
    await pgClient.query(CHARGE_SQL, [keys.identifier, keys.ip, windowSeconds]);
  }
  return admission;
}

// A charge already reads an ended window as zero, so this only reclaims space.
export async function deleteEndedWindows(): Promise<void> {
  await pool.query(`DELETE FROM login_attempts WHERE window_ends_at <= now()`);
}

let sweepStarted = false;

// Idempotent. Deletes ended windows on a timer. The interval is unref'd so
// scripts and tests never hang on it. Only index.ts calls this (after
// app.listen).
export function startSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  setInterval(
    () => {
      deleteEndedWindows().catch((err) =>
        console.error("login_attempts: sweep failed:", err),
      );
    },
    1000 * 60 * 15,
  ).unref();
}
