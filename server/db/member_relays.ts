// The member_relays table (sql/18-member-relays.sql): the record behind
// server/services/discord.ts#relayOnce, its only caller. A member relay is a
// note to Discord about a member's own action. claimRelay records each member's
// relay of each kind once, before anything is posted, and decides whether it
// posts: a second claim never does, and a kind's claims past its hourly
// ceiling are held, so neither one account nor a crowd of new accounts can
// flood a channel.

import assert from "assert";
// 1st
import * as config from "../config";
import {
  exactlyOneRow,
  maybeOneRow,
  pool,
  withPgPoolTransaction,
} from "./util";

// The ceiling in server/config.ts is per this trailing window.
const WINDOW_SECONDS = 60 * 60;

// While a kind is held, staff hear about it at most this often.
const NOTE_COOLDOWN_SECONDS = WINDOW_SECONDS;

// First key of the per-kind advisory lock ("RLAY"). Two-key advisory locks
// never collide with one-key ones such as server/guildbot.ts's.
const LOCK_SPACE = 0x524c4159;

// What claimRelay found under the kind's lock. A new claim counts itself.
export type ClaimFacts =
  | { isNew: false }
  | { isNew: true; count: number; lastNoteAt: Date | null; now: Date };

// "repeat": the member's relay of this kind was claimed before; post nothing.
// "post": post the relay. "hold": over the ceiling; post nothing.
// "hold-and-note": over the ceiling, and staff have not heard within the
// cooldown; post only the note that the kind is held.
export type RelayDecision = "repeat" | "post" | "hold" | "hold-and-note";

// The relay rules, apart from the SQL so a test can run them without a
// database. claimRelay gathers the facts under the lock and applies them.
export function decideRelay(facts: ClaimFacts, ceiling: number): RelayDecision {
  if (!facts.isNew) return "repeat";
  if (facts.count <= ceiling) return "post";
  const noteDue =
    facts.lastNoteAt === null ||
    facts.now.getTime() - facts.lastNoteAt.getTime() >=
      NOTE_COOLDOWN_SECONDS * 1000;
  return noteDue ? "hold-and-note" : "hold";
}

/**
 * Claims the member's relay of `kind` and decides what to post. Every new
 * claim is kept, past the ceiling too, so the count holds claims, not posts,
 * and a held member cannot relay later by trying again. Claiming before
 * posting means a failed post is lost for good, never repeated.
 */
export async function claimRelay(
  kind: string,
  userId: number,
): Promise<RelayDecision> {
  // A claim kind has no colon, so it never meets a note kind
  assert(/^[a-z_]+$/.test(kind), `bad relay kind: ${kind}`);
  assert(Number.isInteger(userId));
  const noteKind = `${kind}:paused`;

  return withPgPoolTransaction(pool, async (pgClient) => {
    // Claims of one kind at once queue here, so each counts the ones before.
    await pgClient.query(
      `SELECT pg_advisory_xact_lock($1::int, hashtext($2))`,
      [LOCK_SPACE, kind],
    );

    // Read the clock after the lock: now() is when the transaction began,
    // which is stale after a wait on the lock.
    const claimed = await pgClient
      .query<{ created_at: Date }>(
        `
        INSERT INTO member_relays (user_id, kind, created_at)
        VALUES ($1, $2, clock_timestamp())
        ON CONFLICT (user_id, kind) DO NOTHING
        RETURNING created_at
      `,
        [userId, kind],
      )
      .then(maybeOneRow);
    if (!claimed) {
      return decideRelay(
        { isNew: false },
        config.MEMBER_RELAY_CEILING_PER_HOUR,
      );
    }
    const now = claimed.created_at;

    const seen = await pgClient
      .query<{ count: number; last_note_at: Date | null }>(
        `
        SELECT
          (SELECT count(*)::int
           FROM member_relays
           WHERE kind = $1
             AND created_at > $2::timestamptz - make_interval(secs => $3)
          ) AS count,
          (SELECT max(created_at)
           FROM member_relays
           WHERE kind = $4
          ) AS last_note_at
      `,
        [kind, now, WINDOW_SECONDS, noteKind],
      )
      .then(exactlyOneRow);

    const decision = decideRelay(
      {
        isNew: true,
        count: seen.count,
        lastNoteAt: seen.last_note_at,
        now,
      },
      config.MEMBER_RELAY_CEILING_PER_HOUR,
    );

    if (decision === "hold-and-note") {
      // Only a member's first claim of a kind is new, so the conflict arm
      // runs only if staff deleted that claim by hand.
      await pgClient.query(
        `
        INSERT INTO member_relays (user_id, kind, created_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, kind) DO UPDATE SET created_at = EXCLUDED.created_at
      `,
        [userId, noteKind, now],
      );
    }
    return decision;
  });
}
