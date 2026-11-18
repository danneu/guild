// The one place an account is made. server/write_census.test.ts fails on any
// other code that inserts a users row, so every account passes the checks in
// createUserWithSession: the signup gate's permit and the network cap.
// server/db/index.ts re-exports it for the register route.
//
// The network cap: one network may open config.SIGNUP_NETWORK_LIMIT accounts
// in any trailing config.SIGNUP_NETWORK_WINDOW_SECONDS. A network is the
// client's ip_root (sql/1-schema.sql#ip_root). The count reads the users rows
// themselves, by registration_ip and created_at, so no second ledger can
// disagree with them. The cap raises the price of an account. It does not
// bound how many accounts exist: a bot that rotates networks gets past it, and
// that is accepted (docs/agents/auth.md#signup).

import _ from "lodash";
import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db");
// 1st party
import * as config from "../config";
import * as belt from "../belt";
import { hashPassword } from "../auth";
import { DbSession, DbUser } from "../dbtypes";
import type { SignupPermit } from "../signup_gate";
import { createSession } from "./sessions";
import { takenBy } from "./unique_violations";
import {
  pool,
  maybeOneRow,
  exactlyOneRow,
  type PgClientInTransaction,
} from "./util";

// First key of the network lock ("SIGN"). Two-key advisory locks never
// collide with one-key ones, and server/db/send_budget.ts#LOCK_SPACE is
// another first key.
const LOCK_SPACE = 0x5349474e;

// What createUserWithSession did. Only CREATED carries the account and its
// session, so a caller cannot read either after a refusal, and an exhaustive
// switch on type makes it answer each refusal.
export type SignupResult =
  | { type: "CREATED"; user: DbUser; session: DbSession }
  | SignupRefusal;

// NETWORK_LIMIT: the client's network opened its limit of accounts in the
// window.
export type SignupRefusal =
  | { type: "UNAME_TAKEN" }
  | { type: "EMAIL_TAKEN" }
  | { type: "NETWORK_LIMIT" };

// Thrown inside createUserWithSession's transaction so that it rolls back.
// The refusal is returned only after the rollback: a value returned from the
// transaction would COMMIT, and a later edit could then commit half an
// account.
class SignupRefused extends Error {
  override name = "SignupRefused";
  constructor(readonly refusal: SignupRefusal) {
    super(refusal.type);
  }
}

// A unique violation on a member's name or address refuses the signup.
// Every other error passes through.
function refuseIfTaken(err: unknown): never {
  const taken = takenBy(err);
  if (taken) throw new SignupRefused({ type: taken });
  throw err;
}

// When the network may open another account, given its newest signups, newest
// first, and the database clock. Null means now. A signup counts while it is
// inside the trailing window, so the network is full while its limit-th
// newest signup is, and frees up when that one leaves. Pure, so the app clock
// never enters the decision.
export function whenNetworkFits(
  newest: Date[],
  now: Date,
  limit: number,
  windowSeconds: number,
): Date | null {
  const gate = newest[limit - 1];
  if (gate === undefined) return null;
  const retryAt = new Date(gate.getTime() + windowSeconds * 1000);
  return retryAt > now ? retryAt : null;
}

// Locks the client's network, then refuses the signup if the network is full.
// Signups at once from one network queue on the lock, so each one counts every
// account the ones before it made. Returns the database clock it decided
// with, which stamps the new account.
async function admitNetwork(
  client: PgClientInTransaction,
  ipAddress: string,
): Promise<Date> {
  assert(client._inTransaction, "client must be in a transaction");
  await client.query(
    `SELECT pg_advisory_xact_lock($1::int, hashtext(host(ip_root($2::inet))))`,
    [LOCK_SPACE, ipAddress],
  );

  // clock_timestamp, not now(): now() is when the transaction began, which is
  // stale after a wait on the lock. Only the newest `limit` signups can
  // decide, so the read stops there.
  const limit = config.SIGNUP_NETWORK_LIMIT;
  const { now, network, newest } = await client
    .query<{ now: Date; network: string; newest: Date[] }>(
      `
      SELECT
        clock_timestamp() AS now,
        host(ip_root($1::inet)) AS network,
        ARRAY(
          SELECT created_at
          FROM users
          WHERE registration_ip IS NOT NULL
            AND ip_root(registration_ip) = ip_root($1::inet)
          ORDER BY created_at DESC
          LIMIT $2
        ) AS newest
    `,
      [ipAddress, limit],
    )
    .then(exactlyOneRow);

  const retryAt = whenNetworkFits(
    newest,
    now,
    limit,
    config.SIGNUP_NETWORK_WINDOW_SECONDS,
  );
  if (retryAt) {
    console.warn(
      `[signup] refused network ${network}: full until ${retryAt.toISOString()}`,
    );
    throw new SignupRefused({ type: "NETWORK_LIMIT" });
  }
  return now;
}

// Creates a user and a session (logs them in). It refuses a network past the
// signup cap. A name in the unames history stays taken unless an admin let it
// be recycled.
//
// The permit is proof that the request passed
// server/signup_gate.ts#admitSignup, so no caller can make an account without
// the registration switch and the human test.
export async function createUserWithSession(
  permit: SignupPermit,
  props: {
    uname: string;
    ipAddress: string;
    password: string;
    email: string;
  },
): Promise<SignupResult> {
  debug("[createUserWithSession] props: ", props);
  assert(permit, "createUserWithSession needs a SignupPermit");
  assert(_.isString(props.uname));
  assert(_.isString(props.ipAddress));
  assert(_.isString(props.password));
  assert(_.isString(props.email));

  const digest = await hashPassword(props.password);
  const slug = belt.slugifyUname(props.uname);

  try {
    return await pool.withTransaction(async (client) => {
      const now = await admitNetwork(client, props.ipAddress);

      const history = await client
        .query(
          `
        SELECT 1
        FROM unames
        WHERE slug = $1
          AND recycle = false
      `,
          [slug],
        )
        .then(maybeOneRow);

      if (history) {
        throw new SignupRefused({ type: "UNAME_TAKEN" });
      }

      const user = await client
        .query<DbUser>(
          `
        INSERT INTO users (uname, digest, email, slug, hide_sigs, registration_ip, email_gate_exempt_at, created_at)
        VALUES ($1, $2, $3, $4, true, $5, $6, $7)
        RETURNING *
      `,
          [
            props.uname,
            digest,
            props.email,
            slug,
            props.ipAddress,
            // Fail-open when we cannot mail a confirmation link at all: without
            // this, local dev and any misconfigured deploy would wall every new
            // account with no way to unwall it (plan/2026-08-11-1613).
            config.IS_EMAIL_CONFIGURED ? null : new Date(),
            // The clock the network cap decided with, so the next signup's
            // count sees this account at the time it was admitted.
            now,
          ],
        )
        .then(exactlyOneRow)
        .catch(refuseIfTaken);

      await client
        .query(
          `
        INSERT INTO unames (user_id, uname, slug)
        VALUES ($1, $2, $3)
      `,
          [user.id, user.uname, user.slug],
        )
        .catch(refuseIfTaken);

      const session = await createSession(client, {
        userId: user.id,
        ipAddress: props.ipAddress,
        interval: "1 year", // TODO: Decide how long to log user in upon registration
      });

      return { type: "CREATED", user, session } as const;
    });
  } catch (err) {
    if (err instanceof SignupRefused) return err.refusal;
    throw err;
  }
}
