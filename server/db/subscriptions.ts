// 3rd
import assert from "assert";
// import createDebug from 'debug';
// const debug = createDebug('app:db:subscriptions')
// 1st
import { pool } from "./util";
import * as db from ".";

////////////////////////////////////////////////////////////

// Do nothing if subscription already exists
export const subscribeToTopic = async function (
  userId: number,
  topicId: number,
) {
  assert(userId);
  assert(topicId);
  return pool.query(
    `
    INSERT INTO topic_subscriptions (user_id, topic_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, topic_id) DO NOTHING
  `,
    [userId, topicId],
  );
};

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
