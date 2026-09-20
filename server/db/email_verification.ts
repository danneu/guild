// Email confirmation tokens -- plan/2026-08-11-1613.
//
// The token row *is* the pending-address state: there is no pending_email
// column on users. Confirmation writes the address recorded on the token, so
// the address that gets verified is by construction the address the clicked
// link was mailed to (plan/2026-08-11-1613/I1).
//
// Expiry kills the link, not the staged address (plan/2026-08-11-1613/I3), so
// every reader of pending state here hits the base table, never the
// active_email_verification_tokens view.

// 3rd
import assert from "assert";
import { v7 as uuidv7 } from "uuid";
// 1st
import {
  pool,
  maybeOneRow,
  withPgPoolTransaction,
  type PgClientInTransaction,
} from "./util";

export type EmailVerificationToken = {
  user_id: number;
  token: string;
  email: string;
  created_at: Date;
  expired_at: Date;
};

// The narrowest shape the queries below need, so they accept a pool, a pooled
// client, or a test fake interchangeably.
type Queryable = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

// The two intervals below are written as literals inside each statement rather
// than interpolated or parameterized:
//
//   24 hours    how long a link stays clickable. Mirrors the column default.
//   60 seconds  how long an issuance must wait behind the previous one. It is
//               compared in SQL, not app-side, so concurrent requests across
//               processes agree and clock skew between app hosts cannot open
//               the window.

////////////////////////////////////////////////////////////

// The one token row for this user, expired or not. Pending state survives
// expiry (I3), so callers that render "awaiting confirmation of X" or pick a
// resend destination read this, not the active_* view.
export async function findPendingEmailVerification(
  userId: number,
): Promise<EmailVerificationToken | undefined> {
  assert(Number.isInteger(userId));

  return pool
    .query(
      `
    SELECT *
    FROM email_verification_tokens
    WHERE user_id = $1
  `,
      [userId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// Stage `email` for confirmation and mint a fresh link for it.
//
// One statement, so the row that survives is always one complete
// (token, address) pair and a link mailed to a superseded address stops
// working. The 60s throttle lives in the ON CONFLICT ... WHERE: when the
// existing row is younger than that, nothing is replaced and no row comes
// back, which is the caller's signal to send no mail and report 429.
//
// Mail must go to the address on the returned row and nowhere else, so a lost
// race can never mail one address while the row records another.
export async function stageEmailVerification(
  userId: number,
  email: string,
): Promise<EmailVerificationToken | undefined> {
  assert(Number.isInteger(userId));
  assert(typeof email === "string");

  return pool
    .query(
      `
    INSERT INTO email_verification_tokens (user_id, token, email, created_at, expired_at)
    VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '24 hours')
    ON CONFLICT (user_id) DO UPDATE
      SET token = EXCLUDED.token,
          email = EXCLUDED.email,
          created_at = EXCLUDED.created_at,
          expired_at = EXCLUDED.expired_at
      WHERE email_verification_tokens.created_at < NOW() - INTERVAL '60 seconds'
    RETURNING *
  `,
      [userId, uuidv7(), email],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// Renew the existing staging with a fresh token value and expiry.
//
// Resend never chooses a destination (I3): it keeps whatever address the row
// already records. `fallbackEmail` is used only when there is no row at all --
// an account that has never been mailed a link -- in which case the account's
// current address is the only sensible thing to confirm.
export async function resendEmailVerification(
  userId: number,
  fallbackEmail: string,
): Promise<EmailVerificationToken | undefined> {
  assert(Number.isInteger(userId));
  assert(typeof fallbackEmail === "string");

  return pool
    .query(
      `
    INSERT INTO email_verification_tokens (user_id, token, email, created_at, expired_at)
    VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '24 hours')
    ON CONFLICT (user_id) DO UPDATE
      SET token = EXCLUDED.token,
          created_at = EXCLUDED.created_at,
          expired_at = EXCLUDED.expired_at
      WHERE email_verification_tokens.created_at < NOW() - INTERVAL '60 seconds'
    RETURNING *
  `,
      [userId, uuidv7(), fallbackEmail],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

// Thrown out of the consume transaction when the confirmed address has been
// claimed by another account since it was staged. It must *throw* rather than
// resolve: withPgPoolTransaction only rolls back on a throw, and a returned
// error value would commit a transaction Postgres has already aborted.
export class EmailTakenError extends Error {
  constructor() {
    super("EMAIL_TAKEN");
    this.name = "EmailTakenError";
  }
}

export type ConsumeResult =
  | { type: "OK"; userId: number; email: string }
  | { type: "INVALID" };

// Consume a confirmation link. Must run inside a transaction.
//
// The DELETE is the gate: it is what makes a double-clicked link idempotent,
// and its `expired_at >= NOW()` is what makes an expired link dead. When it
// matches nothing the UPDATE is never issued at all.
//
// The address written to users comes from the DELETE's own RETURNING and from
// nowhere else, which is I1.
export async function consumeEmailVerificationTokenTx(
  pgClient: PgClientInTransaction,
  token: string,
): Promise<ConsumeResult> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(typeof token === "string");

  const consumed = await pgClient
    .query(
      `
    DELETE FROM email_verification_tokens
    WHERE token = $1
      AND expired_at >= NOW()
    RETURNING user_id, email
  `,
      [token],
    )
    .then(maybeOneRow);

  if (!consumed) {
    return { type: "INVALID" };
  }

  try {
    // The legacy email_verified dual-write is gone (phase 3 of
    // plan/2026-08-11-1613). It existed only to keep the boolean legible across
    // the two builds during the rollout; the reconciliation sweep has since
    // made the stamp authoritative, and the column is dropped by
    // sql/10-drop-email-verified.sql once this build is deployed.
    await pgClient.query(
      `
      UPDATE users
      SET email = $1,
          email_verified_at = NOW()
      WHERE id = $2
    `,
      [consumed.email, consumed.user_id],
    );
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      err.code === "23505" &&
      /unique_email/.test(err.toString())
    ) {
      throw new EmailTakenError();
    }
    throw err;
  }

  return { type: "OK", userId: consumed.user_id, email: consumed.email };
}

////////////////////////////////////////////////////////////

// Clear the staging that collided, after the transaction above rolled back.
//
// Keys on the exact token value that collided, never on user_id: a user who
// staged a different address in the meantime owns a *different* token value on
// the same row, and a delete-by-user would silently discard it.
export async function deleteEmailVerificationTokenByToken(
  db: Queryable,
  token: string,
): Promise<void> {
  assert(typeof token === "string");

  await db.query(
    `
    DELETE FROM email_verification_tokens
    WHERE token = $1
  `,
    [token],
  );
}

////////////////////////////////////////////////////////////

// Route-facing wrapper around the consume transaction.
//
// The collision cleanup runs *after* the rollback, because the rollback
// un-deletes the token row: without this the user would sit in "pending
// confirmation" forever on an address they can never have.
export async function consumeEmailVerificationToken(
  token: string,
): Promise<ConsumeResult | { type: "EMAIL_TAKEN" }> {
  try {
    return await withPgPoolTransaction(pool, (pgClient) =>
      consumeEmailVerificationTokenTx(pgClient, token),
    );
  } catch (err) {
    if (err instanceof EmailTakenError) {
      await deleteEmailVerificationTokenByToken(pool, token);
      return { type: "EMAIL_TAKEN" };
    }
    throw err;
  }
}

////////////////////////////////////////////////////////////

// Excuse an account from the write gate without claiming anything about its
// address. Deliberately not a force-verify: stamping email_verified_at on an
// address nobody confirmed would poison the mailer predicate, which is the
// outcome the two-column split exists to prevent.
//
// COALESCE keeps the original grant time on a repeat click.
export async function grantEmailGateExemption(userId: number): Promise<void> {
  assert(Number.isInteger(userId));

  await pool.query(
    `
    UPDATE users
    SET email_gate_exempt_at = COALESCE(email_gate_exempt_at, NOW())
    WHERE id = $1
  `,
    [userId],
  );
}
