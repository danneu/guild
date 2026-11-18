// The per-account hourly budgets on rows a member can create over and over
// that are neither posts nor sends: dice campaigns, dice rolls and albums. The
// writer of each kind calls admitRow in its own transaction, after
// lockStanding and before its insert, so inserts at once queue on the lock and
// each counts the ones before it, and a refused insert writes nothing
// (docs/agents/budgets.md#other-member-text).
//
// The ledger is the kind's own table: admitRow counts the member's rows of
// that kind created in the trailing hour, so no second record can drift from
// what was written. Each kind has its own budget, so a burst of rolls never
// blocks a campaign, a post or a PM.

import assert from "assert";
// 1st
import * as belt from "../belt";
import * as config from "../config";
import { MemberRefusal } from "../member_refusal";
import { whenItFits, type Standing } from "./send_budget";
import { exactlyOneRow, type PgClientInTransaction } from "./util";

// The budgets in server/config.ts are per this trailing window.
const WINDOW_SECONDS = 60 * 60;

export type RowKind = keyof typeof config.ROW_BUDGET_PER_HOUR;

// Each kind's table, which has user_id and created_at columns, and how a
// refusal names its rows. The table names are constants, never member input.
const KINDS: Record<RowKind, { table: string; label: string }> = {
  campaign: { table: "campaigns", label: "dice campaigns" },
  roll: { table: "rolls", label: "dice rolls" },
  album: { table: "albums", label: "albums" },
};

// A new row refused because its member already made their hour's budget of
// that kind. Nothing was written. server/middleware/refusals.ts answers it.
// The form is not echoed, since a campaign may hold long markup.
export class RowBudgetExceeded extends MemberRefusal {
  readonly retryAt: Date;

  constructor(kind: RowKind, retryAt: Date, trusted: boolean) {
    super(
      `You have reached your limit on new ${KINDS[kind].label} for the past hour. Try again in ${belt.waitLength(retryAt)}.` +
        (trusted
          ? ""
          : " The limit goes up once your first few posts are a few days old."),
    );
    this.name = "RowBudgetExceeded";
    this.retryAt = retryAt;
  }
}

// Admits one new row of `kind` for the member, or throws RowBudgetExceeded.
// Returns the database time the decision read, which the insert stamps as
// the row's created_at, so the next count sees the row where this one put it.
// Call it in the insert's transaction, after lockStanding.
export async function admitRow(
  pgClient: PgClientInTransaction,
  standing: Standing,
  kind: RowKind,
): Promise<Date> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  const { table } = KINDS[kind];
  const budgets = config.ROW_BUDGET_PER_HOUR[kind];
  const budget = standing.trusted ? budgets.trusted : budgets.untrusted;

  // clock_timestamp, not now(): now() is when the transaction began, which
  // is stale after a wait on the lock.
  const { now } = await pgClient
    .query<{ now: Date }>(`SELECT clock_timestamp() AS now`)
    .then(exactlyOneRow);

  // The newest `budget` rows decide: a new row fits once fewer than `budget`
  // are left in the window. Each table's user_id index serves this read.
  const newest = await pgClient
    .query<{ created_at: Date }>(
      `
      SELECT created_at
      FROM ${table}
      WHERE user_id = $1
        AND created_at > $2::timestamptz - make_interval(secs => $3)
      ORDER BY created_at DESC
      LIMIT $4
    `,
      [standing.id, now, WINDOW_SECONDS, budget],
    )
    .then((res) => res.rows);

  const rows = newest
    .reverse()
    .map((row) => ({ cost: 1, created_at: row.created_at }));
  const retryAt = whenItFits(rows, 1, budget, WINDOW_SECONDS);
  if (retryAt) {
    console.warn(
      `[row_budget] refused a ${kind} for user ${standing.id}: ${budget} in the past hour`,
    );
    throw new RowBudgetExceeded(kind, retryAt, standing.trusted);
  }
  return now;
}
