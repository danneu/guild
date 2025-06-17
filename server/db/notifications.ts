// TODO: Move notification queries here

import { DbNotification } from "../dbtypes";
import { maybeOneRow, PgClientInTransaction } from "./util";

export async function deleteRatingNotification(
  pgClient: PgClientInTransaction,
  { fromUserId, postId }: { fromUserId: number; postId: number },
) {
  return pgClient
    .query<DbNotification>(
      `
    DELETE FROM notifications
    WHERE type = 'RATING' 
      AND from_user_id = $1 
      AND post_id = $2
    RETURNING *
    `,
      [fromUserId, postId],
    )
    .then(maybeOneRow);
}
