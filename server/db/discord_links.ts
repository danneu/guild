// The discord_links table: the one Discord account each forum account may add
// to the Discord server. Only server/discord/join.ts#joinDiscord claims a
// link. Staff clear one by hand; sql/15-discord-links.sql says what that
// leaves behind.

import { exactlyOneRow, pool } from "./util";

// The primary key on user_id makes the first claim stand, so two callbacks
// that race with different Discord ids cannot both win. The no-op update
// makes a conflicting claim return the stored row.
const CLAIM_SQL = `
  INSERT INTO discord_links AS l (user_id, discord_user_id)
  VALUES ($1, $2)
  ON CONFLICT (user_id) DO UPDATE SET user_id = l.user_id
  RETURNING l.discord_user_id
`;

/**
 * Claims the forum account's link for discordUserId, unless it holds one
 * already. Returns the Discord id the link holds after the claim: the caller
 * may add that account and no other. Claiming the same id again changes
 * nothing, so a failed add needs no cleanup.
 */
export async function claimDiscordLink(
  userId: number,
  discordUserId: string,
): Promise<string> {
  const row = await pool
    .query<{ discord_user_id: string }>(CLAIM_SQL, [userId, discordUserId])
    .then(exactlyOneRow);
  return row.discord_user_id;
}
