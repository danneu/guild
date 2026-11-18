// The gap a member leaves between new posts and topics. createPost and
// createTopic in server/db/forum_text_writes.ts call admitPost in their own
// transaction, under lockStanding, before the insert. So the check, the stamp
// and the post commit together or not at all: two posts at once cannot both
// pass, and a refused or failed post leaves no stamp. That module is the only
// code that inserts posts (server/write_census.test.ts holds that), so no post
// route can skip the gap.
//
// The ledger is the ratelimits table (sql/1-schema.sql), one row per account:
// its last admitted post. Only admitPost writes it.

import assert from "assert";
// 1st
import * as belt from "../belt";
import { MemberRefusal } from "../member_refusal";
import type { Standing } from "./send_budget";
import { exactlyOneRow, type PgClientInTransaction } from "./util";

// A new member waits long enough that the spam check paces them. A trusted
// member's gap only stops a double submit. Trust is server/trust.ts.
const UNTRUSTED_GAP_SECONDS = 10;
const TRUSTED_GAP_SECONDS = 1;

// A post or topic refused because its author posted too recently. Nothing was
// written. server/middleware/refusals.ts answers it and fills the form in
// again, so the member can post it once the gap ends.
export class PostTooSoon extends MemberRefusal {
  override readonly echoForm = true;
  readonly retryAt: Date;

  constructor(retryAt: Date) {
    super(
      `You are posting too fast. Try again in ${belt.waitLength(retryAt)}.`,
    );
    this.name = "PostTooSoon";
    this.retryAt = retryAt;
  }
}

// When the author may post again, given their last admitted post and the
// database clock. Null means now. Pure, so the app clock never enters the
// decision.
function whenPostFits(
  lastPostAt: Date | null,
  now: Date,
  trusted: boolean,
): Date | null {
  if (lastPostAt === null) return null;
  const gapSeconds = trusted ? TRUSTED_GAP_SECONDS : UNTRUSTED_GAP_SECONDS;
  const retryAt = new Date(lastPostAt.getTime() + gapSeconds * 1000);
  return retryAt > now ? retryAt : null;
}

// Stamps a new post by the author, or throws PostTooSoon and writes nothing.
// Call it in the post's transaction, after lockStanding and before the insert.
export async function admitPost(
  pgClient: PgClientInTransaction,
  standing: Standing,
  ipAddress: string,
): Promise<void> {
  assert(pgClient._inTransaction, "pgClient must be in a transaction");
  assert(typeof ipAddress === "string");

  // clock_timestamp, not now(): now() is when the transaction began, which
  // is stale after a wait on the lock. The stamp is written with this value.
  const { now, last_post_at } = await pgClient
    .query<{ now: Date; last_post_at: Date | null }>(
      `
      SELECT
        clock_timestamp() AS now,
        (SELECT max(created_at) FROM ratelimits WHERE user_id = $1)
          AS last_post_at
    `,
      [standing.id],
    )
    .then(exactlyOneRow);

  const retryAt = whenPostFits(last_post_at, now, standing.trusted);
  if (retryAt) throw new PostTooSoon(retryAt);

  // Only the newest stamp counts, so it replaces the account's older rows.
  await pgClient.query(
    `
    DELETE FROM ratelimits
    WHERE user_id = $1
  `,
    [standing.id],
  );
  await pgClient.query(
    `
    INSERT INTO ratelimits (user_id, ip_address, created_at)
    VALUES ($1, $2::inet, $3)
  `,
    [standing.id, ipAddress, now],
  );
}
