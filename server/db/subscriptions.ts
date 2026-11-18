// 3rd
import assert from "assert";
// import createDebug from 'debug';
// const debug = createDebug('app:db:subscriptions')
// 1st
import { pool } from "./util";
import * as db from ".";
import { countReadableSubscriptions } from "./notifications";
import { lockSender } from "./send_budget";

////////////////////////////////////////////////////////////

// The most unarchived subscriptions a member may keep
export const MAX_SUBSCRIPTIONS = 200;

export type SubscribeResult = { type: "SUBSCRIBED" } | { type: "TOO_MANY" };

// Subscribes the viewer to the topic, unless they already keep
// MAX_SUBSCRIPTIONS they can read. The count and the insert share one
// transaction behind lockSender, so a burst of subscribes cannot all pass the
// cap. A topic the viewer already follows adds nothing.
export async function subscribeToTopic(
  viewer: { id: number; role: string },
  topicId: number,
): Promise<SubscribeResult> {
  assert(Number.isInteger(topicId));

  return pool.withTransaction(async (client) => {
    await lockSender(client, viewer.id);
    const count = await countReadableSubscriptions(client, viewer);
    if (count >= MAX_SUBSCRIPTIONS) return { type: "TOO_MANY" };

    await client.query(
      `
      INSERT INTO topic_subscriptions (user_id, topic_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, topic_id) DO NOTHING
    `,
      [viewer.id, topicId],
    );
    return { type: "SUBSCRIBED" };
  });
}

////////////////////////////////////////////////////////////

// unsub/archive should delete any existing notifications
export const massUpdate = async function (
  userId: number,
  topicIds: number[],
  action: string,
) {
  assert(["unsub", "archive", "unarchive"].includes(action));

  if (action === "archive") {
    return Promise.all([
      pool.query(
        `
        UPDATE topic_subscriptions
        SET is_archived = true
        WHERE topic_id = ANY ($1)
          AND user_id = $2
        RETURNING *
      `,
        [topicIds, userId],
      ),
      db.deleteSubNotifications(userId, topicIds),
    ]);
  }

  if (action === "unsub") {
    return Promise.all([
      pool.query(
        `
        DELETE FROM topic_subscriptions
        WHERE topic_id = ANY ($1)
          AND user_id = $2
      `,
        [topicIds, userId],
      ),
      db.deleteSubNotifications(userId, topicIds),
    ]);
  }

  if (action === "unarchive") {
    return pool.query(
      `
      UPDATE topic_subscriptions
      SET is_archived = false
      WHERE topic_id = ANY ($1)
        AND user_id = $2
      RETURNING *
    `,
      [topicIds, userId],
    );
  }

  assert(false);
};

////////////////////////////////////////////////////////////

// Delete any existing notifications for topic
export const unsubscribeFromTopic = async function (
  userId: number,
  topicId: number,
) {
  return Promise.all([
    pool.query(
      `
      DELETE FROM topic_subscriptions
      WHERE user_id = $1 AND topic_id = $2
    `,
      [userId, topicId],
    ),
    db.deleteSubNotifications(userId, [topicId]),
  ]);
};
