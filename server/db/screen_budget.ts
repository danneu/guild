// The per-account screening budget. A call that sends member text to the spam
// classifier (server/services/antispam) needs a ScreeningCharge, and only
// spendScreening makes one. The one call without a charge is
// server/services/antispam/claude.ts#probe, which sends a fixed sample and no
// member text. spendScreening prices the exact payload the classifier will
// send and charges it to the actor, inside the transaction of the write that
// stores the text, before the insert. So one account cannot make the
// classifier run without paying, and a write over budget is refused, never
// landed unscreened.
//
// The ledger is the screen_spends table (sql/14-screen-spends.sql). Only
// spendScreening writes it, under server/db/send_budget.ts#lockStanding.

import assert from "assert";
// 1st
import * as belt from "../belt";
import * as config from "../config";
import { MemberRefusal } from "../member_refusal";
import { whenItFits, type Standing } from "./send_budget";
import type { PgClientInTransaction } from "./util";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every call costs this much on top of its size, so many small calls cost
// more than their bytes alone.
const UNITS_PER_CALL = 8;
// Size is charged per this many UTF-8 bytes of payload, rounded up.
const BYTES_PER_UNIT = 1024;

// The text a write sends to the classifier. A title goes only with a topic's
// text: a new topic, or a retitle with its opening post.
export type ScreeningText = { title: string | null; body: string };

// The JSON the classifier sends. Built only here, so the price and the request
// cannot disagree. A script that calls the classifier without a write builds
// its payload here too, so it sends what a write would.
export function buildPayload(uname: string, text: ScreeningText): string {
  return JSON.stringify({
    username: uname,
    title: text.title,
    body: text.body,
  });
}

// What a payload costs: escapes and multi-byte text pay for every byte sent.
function priceOf(payload: string): number {
  return (
    UNITS_PER_CALL +
    Math.ceil(Buffer.byteLength(payload, "utf8") / BYTES_PER_UNIT)
  );
}

// The costliest payload a write can send: the longest uname, title and post
// the validators allow, with every character escaped to six bytes (\u0000),
// the most JSON spends on one UTF-16 code unit. A unit budget below its price
// would refuse that write forever.
const LARGEST_PRICE = priceOf(
  buildPayload("\u0000".repeat(config.MAX_UNAME_LENGTH), {
    title: "\u0000".repeat(config.MAX_TOPIC_TITLE_LENGTH),
    body: "\u0000".repeat(config.MAX_POST_LENGTH),
  }),
);
for (const budget of [
  config.SCREEN_BUDGET_PER_HOUR,
  config.SCREEN_BUDGET_PER_DAY,
]) {
  assert(
    Number.isInteger(budget) && budget >= LARGEST_PRICE,
    `Screening budgets must be integers of at least ${LARGEST_PRICE}, the price of the largest payload`,
  );
}
assert(
  Number.isInteger(config.SCREEN_CALLS_PER_MINUTE) &&
    config.SCREEN_CALLS_PER_MINUTE >= 1,
  "SCREEN_CALLS_PER_MINUTE must be a positive integer",
);

// Proof that a write paid for one classifier call, and the payload that call
// sends. The module exports it only as a type, and its private field keeps any
// other object from passing for one, so only spendScreening makes one.
class ScreeningCharge {
  #payload: string | null;
  readonly cost: number;
  // The actor as the write read them under the lock
  readonly standing: Standing;
  // The text the payload carries as its body, for the moderators' notes
  readonly body: string;

  constructor(standing: Standing, cost: number, payload: string, body: string) {
    this.standing = standing;
    this.cost = cost;
    this.#payload = payload;
    this.body = body;
  }

  // Hands out the payload for the one call this charge paid for.
  take(): string {
    const payload = this.#payload;
    assert(payload !== null, "A screening charge pays for one call");
    this.#payload = null;
    return payload;
  }
}

export type { ScreeningCharge };

// A write refused because its actor's screening budget cannot pay for it.
// Nothing was written. server/middleware/refusals.ts answers it. The form is
// not echoed, since it may hold long markup.
export class ScreeningBudgetExceeded extends MemberRefusal {
  readonly retryAt: Date;

  constructor(retryAt: Date) {
    super(
      `You have reached the posting limit for new members. Try again in ${belt.waitLength(retryAt)}.`,
    );
    this.name = "ScreeningBudgetExceeded";
    this.retryAt = retryAt;
  }
}

export type ScreenSpend = { id: string; cost: number; created_at: Date };

export type ScreenLimits = {
  callsPerMinute: number;
  unitsPerHour: number;
  unitsPerDay: number;
};

// Whether a charge of `cost` fits now, given the actor's spends oldest first
// and the database clock. The minute window counts calls, to pace a burst; the
// hour and day windows count units, to bound what one account sends. retryAt
// is null when the charge fits now, or else the first time every window has
// room. expired names the spends no window counts any more.
export function decideScreening(
  spends: ScreenSpend[],
  cost: number,
  now: Date,
  limits: ScreenLimits,
): { retryAt: Date | null; expired: string[] } {
  // A spend counts in a window while it is younger than the window.
  function isInside(spend: ScreenSpend, seconds: number): boolean {
    return spend.created_at.getTime() > now.getTime() - seconds * 1000;
  }
  function inside(seconds: number): ScreenSpend[] {
    return spends.filter((s) => isInside(s, seconds));
  }
  const calls = inside(MINUTE).map((s) => ({
    cost: 1,
    created_at: s.created_at,
  }));
  const waits = [
    whenItFits(calls, 1, limits.callsPerMinute, MINUTE),
    whenItFits(inside(HOUR), cost, limits.unitsPerHour, HOUR),
    whenItFits(inside(DAY), cost, limits.unitsPerDay, DAY),
  ].filter((wait): wait is Date => wait !== null);
  return {
    retryAt:
      waits.length === 0
        ? null
        : new Date(Math.max(...waits.map((wait) => wait.getTime()))),
    expired: spends.filter((s) => !isInside(s, DAY)).map((s) => s.id),
  };
}

// Charges the classifier call for `text` to the actor and returns the charge
// the classifier requires, or throws ScreeningBudgetExceeded and writes
// nothing. A trusted actor is not screened: it returns null and touches no
// ledger. Call it in the write's transaction, after lockStanding and before
// the insert.
export async function spendScreening(
  pgClient: PgClientInTransaction,
  standing: Standing,
  text: ScreeningText,
): Promise<ScreeningCharge | null> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(typeof text.body === "string");
  if (standing.trusted) return null;

  const payload = buildPayload(standing.uname, text);
  const cost = priceOf(payload);

  // clock_timestamp, not now(): now() is when the transaction began, which
  // is stale after a wait on the lock. The charge is stamped with this value.
  const now = await pgClient
    .query<{ now: Date }>(`SELECT clock_timestamp() AS now`)
    .then((res) => res.rows[0]!.now);
  const spends = await pgClient
    .query<ScreenSpend>(
      `
      SELECT id, cost, created_at
      FROM screen_spends
      WHERE user_id = $1
      ORDER BY created_at
    `,
      [standing.id],
    )
    .then((res) => res.rows);

  const { retryAt, expired } = decideScreening(spends, cost, now, {
    callsPerMinute: config.SCREEN_CALLS_PER_MINUTE,
    unitsPerHour: config.SCREEN_BUDGET_PER_HOUR,
    unitsPerDay: config.SCREEN_BUDGET_PER_DAY,
  });

  // Expired spends never count again. Dropping them keeps the table small.
  if (expired.length > 0) {
    await pgClient.query(
      `
      DELETE FROM screen_spends
      WHERE id = ANY($1::bigint[])
    `,
      [expired],
    );
  }

  if (retryAt) throw new ScreeningBudgetExceeded(retryAt);

  await pgClient.query(
    `
    INSERT INTO screen_spends (user_id, cost, created_at)
    VALUES ($1, $2, $3)
  `,
    [standing.id, cost, now],
  );

  return new ScreeningCharge(standing, cost, payload, text.body);
}
