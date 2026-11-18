// The per-account send budget. Every member send pays here, inside the
// transaction that writes it, so no member send lands unpaid. The send write
// functions in server/db/index.ts are the only callers of spend, and each one
// sets its own cost from what it writes; routes never pass a cost.
//
// The ledger is the send_spends table (sql/11-send-spends.sql). Only spend
// writes it, so it cannot disagree with what was sent.

import assert from "assert";
// 1st
import * as belt from "../belt";
import * as config from "../config";
import { isTrustedMember } from "../trust";
import { exactlyOneRow, type PgClientInTransaction } from "./util";

// The budgets in server/config.ts are per this trailing window.
const WINDOW_SECONDS = 60 * 60;

// First key of lockSender's advisory lock ("SEND").
// Two-key advisory locks never collide with one-key ones such as
// server/guildbot.ts's.
export const LOCK_SPACE = 0x53454e44;

// The per-account lock. It serializes one account's sends until the
// transaction ends, and every other per-account limit too: a write that checks
// a gap, a window or a cap on an account takes it first, so writes at once
// cannot all pass the check (docs/agents/budgets.md#per-account-limits). It is
// not a users row lock: the send triggers write other members' users rows (pms
// and notification counts), so locking the sender's row up front would
// deadlock two members who send to each other at once.
//
// A write must take this before any other lock on its account, or it can
// deadlock against the account's other writes. spend takes it, and so does
// anything that locks the sender earlier in a send's transaction, such as
// server/db/convos.ts#isFirstStartedConvo. Postgres lets a transaction take an
// advisory lock it already holds, so taking it twice is fine.
export async function lockSender(
  pgClient: PgClientInTransaction,
  userId: number,
): Promise<void> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(Number.isInteger(userId));
  await pgClient.query(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [
    LOCK_SPACE,
    userId,
  ]);
}

// The actor as one write's gates see it. A write reads it once, through
// lockStanding, and hands it to each gate, so the gates cannot disagree about
// who is trusted.
export type Standing = {
  id: number;
  uname: string;
  // Before this write: a write's own post is not counted yet
  posts_count: number;
  // server/trust.ts#isTrustedMember
  trusted: boolean;
};

// Takes lockSender, then reads the actor's standing. Read under the lock, it
// counts every locked write the actor finished before this one, such as the
// post that made them trusted, and none of them can change it until this
// write ends.
export async function lockStanding(
  pgClient: PgClientInTransaction,
  userId: number,
): Promise<Standing> {
  await lockSender(pgClient, userId);
  const row = await pgClient
    .query<{
      id: number;
      uname: string;
      approved_at: Date | null;
      posts_count: number;
    }>(
      `
      SELECT id, uname, approved_at, posts_count
      FROM users
      WHERE id = $1
    `,
      [userId],
    )
    .then(exactlyOneRow);
  return {
    id: row.id,
    uname: row.uname,
    posts_count: row.posts_count,
    trusted: isTrustedMember(row),
  };
}

export type Spend = { cost: number; created_at: Date };

// A send refused because it would take its sender past their budget. Routes
// turn it into a flash; nothing was written.
export class SendBudgetExceeded extends Error {
  readonly retryAt: Date;

  constructor(retryAt: Date, trusted: boolean) {
    super(
      `You have reached your sending limit for the past hour. Try again in ${belt.waitLength(retryAt)}.` +
        (trusted ? "" : " The limit goes up after your first few posts."),
    );
    this.name = "SendBudgetExceeded";
    this.retryAt = retryAt;
  }
}

// For a route's .catch() around a send: resolves to the refusal so the route
// can answer it, and rethrows every other failure.
export function catchRefusal(err: unknown): SendBudgetExceeded {
  if (err instanceof SendBudgetExceeded) return err;
  throw err;
}

// When a send of `cost` fits under `budget`, given the sender's spends still in
// the window, oldest first. Null means it fits now. Otherwise it fits once
// enough of the oldest spends have left the window. The screening budget
// checks its own windows with it too.
export function whenItFits(
  spends: Spend[],
  cost: number,
  budget: number,
  windowSeconds: number = WINDOW_SECONDS,
): Date | null {
  assert(
    cost <= budget,
    `A send of ${cost} can never fit a budget of ${budget}`,
  );
  let spent = spends.reduce((sum, s) => sum + s.cost, 0);
  if (spent + cost <= budget) return null;
  for (const s of spends) {
    spent -= s.cost;
    if (spent + cost <= budget) {
      return new Date(s.created_at.getTime() + windowSeconds * 1000);
    }
  }
  // Once every spend has left, spent is 0, and cost <= budget fits.
  assert.fail("unreachable");
}

// Charges `cost` to the sender, or throws SendBudgetExceeded and writes
// nothing. Call it before the send's insert, in the same transaction.
export async function spend(
  pgClient: PgClientInTransaction,
  userId: number,
  cost: number,
): Promise<void> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(Number.isInteger(userId));
  assert(Number.isInteger(cost) && cost > 0, `cost must be positive: ${cost}`);

  // Two sends at once cannot both fit.
  const { trusted } = await lockStanding(pgClient, userId);
  const budget = trusted
    ? config.SEND_BUDGET_PER_HOUR_TRUSTED
    : config.SEND_BUDGET_PER_HOUR_UNTRUSTED;

  // Expired spends never count again. Dropping them keeps the table small.
  await pgClient.query(
    `
    DELETE FROM send_spends
    WHERE user_id = $1
      AND created_at <= NOW() - make_interval(secs => $2)
  `,
    [userId, WINDOW_SECONDS],
  );

  const spends = await pgClient
    .query<Spend>(
      `
      SELECT cost, created_at
      FROM send_spends
      WHERE user_id = $1
        AND created_at > NOW() - make_interval(secs => $2)
      ORDER BY created_at
    `,
      [userId, WINDOW_SECONDS],
    )
    .then((res) => res.rows);

  const retryAt = whenItFits(spends, cost, budget);
  if (retryAt) throw new SendBudgetExceeded(retryAt, trusted);

  await pgClient.query(
    `
    INSERT INTO send_spends (user_id, cost)
    VALUES ($1, $2)
  `,
    [userId, cost],
  );
}
