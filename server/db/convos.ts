// 3rd
import assert from "assert";
import _ from "lodash";
import createDebug from "debug";
const debug = createDebug("app:db:convos");
// 1st
import * as config from "../config";
import { pool, maybeOneRow } from "./util";

////////////////////////////////////////////////////////////

export const getConvo = async (id) => {
  assert(id);
  return getConvos([id]).then(([x]) => x);
};

export const getConvos = async (ids) => {
  debug("[getConvos] ids=%j", ids);
  assert(Array.isArray(ids));

  return pool
    .query(
      `
    SELECT
      c.*,
      to_json(u1.*) "user",
      to_json(array_agg(u2.*)) "participants",
      json_agg(cp.*) "cp"
    FROM convos c
    JOIN convos_participants cp ON c.id = cp.convo_id AND deleted_at IS NULL
    JOIN users u1 ON c.user_id = u1.id
    JOIN users u2 ON cp.user_id = u2.id
    WHERE c.id = ANY ($1::int[])
    GROUP BY c.id, u1.id
  `,
      [ids],
    )
    .then((res) => res.rows);
};

////////////////////////////////////////////////////////////

// Also clears notifications associated with those convos
export async function deleteTrash(userId: number) {
  return pool.withTransaction(async (client) => {
    const convoIds = await client
      .query<{ convo_id: number }>(
        `
          UPDATE convos_participants
          SET deleted_at = NOW()
          WHERE user_id = $1
            AND folder = 'TRASH'
          RETURNING convo_id
        `,
        [userId],
      )
      .then((res) => res.rows.map((row) => row.convo_id));

    if (convoIds.length > 0) {
      await client.query(
        `
            DELETE FROM notifications
            WHERE to_user_id = $1
              AND convo_id = ANY ($2)
          `,
        [userId, convoIds],
      );
    }
  });
}

////////////////////////////////////////////////////////////

export async function deleteConvos(userId: number, convoIds: number[]) {
  debug(`[deleteConvos] userId=%j, convoIds=%j`, userId, convoIds);
  assert(Number.isInteger(userId));
  assert(Array.isArray(convoIds));

  return pool.query(
    `
    UPDATE convos_participants
    SET deleted_at = NOW()
    WHERE user_id = $1
      AND convo_id = ANY ($2::int[])
  `,
    [userId, convoIds],
  );
}

////////////////////////////////////////////////////////////

export async function getConvoParticipantsWithNotifications(userId: number) {
  assert(Number.isInteger(userId));
  return pool
    .query(
      `
    select cp.*
    from convos_participants cp
    join notifications n ON cp.convo_id = n.convo_id AND cp.user_id = $1
    join users u on n.to_user_id = u.id
    where u.id = $1
  `,
      [userId],
    )
    .then((res) => res.rows);
}

////////////////////////////////////////////////////////////

export async function getConvoFolderCounts(userId: number) {
  assert(Number.isInteger(userId));

  return pool
    .query(
      `
    SELECT
      COUNT(*) FILTER (WHERE folder = 'INBOX') "inbox_count",
      COUNT(*) FILTER (WHERE folder = 'STAR') "star_count",
      COUNT(*) FILTER (WHERE folder = 'ARCHIVE') "archive_count",
      COUNT(*) FILTER (WHERE folder = 'TRASH') "trash_count"
    FROM convos_participants
    WHERE user_id = $1
      AND deleted_at IS NULL
  `,
      [userId],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function findConvosInvolvingUserId(
  userId: number,
  folder: string,
  page: number,
) {
  assert(_.isNumber(page));
  assert(["INBOX", "STAR", "ARCHIVE", "TRASH"].includes(folder));

  const offset = config.CONVOS_PER_PAGE * (page - 1);
  const limit = config.CONVOS_PER_PAGE;

  const rows = await pool
    .query(
      `
SELECT
  c.id,
  c.title,
  c.created_at,
  c.latest_pm_id,
  c.pms_count,
  cp2.folder,
  u1.uname "user.uname",
  u1.slug "user.slug",
  json_agg(u2.uname) "participant_unames",
  json_agg(u2.slug) "participant_slugs",
  pms.id "latest_pm.id",
  pms.created_at "latest_pm.created_at",
  u3.uname "latest_user.uname",
  u3.slug "latest_user.slug"
FROM convos c
JOIN convos_participants cp ON c.id = cp.convo_id AND cp.deleted_at IS NULL
JOIN users u1 ON c.user_id = u1.id
JOIN users u2 ON cp.user_id = u2.id
JOIN pms ON c.latest_pm_id = pms.id
JOIN users u3 ON pms.user_id = u3.id
JOIN convos_participants cp2 ON c.id = cp2.convo_id AND cp2.deleted_at IS NULL
WHERE c.id IN (
    SELECT cp.convo_id
    FROM convos_participants cp
  )
  AND (cp2.folder = $1 AND cp2.user_id = $2)
GROUP BY c.id, u1.id, pms.id, u3.id, cp2.folder
ORDER BY c.latest_pm_id DESC
OFFSET $3
LIMIT $4
  `,
      [folder, userId, offset, limit],
    )
    .then((res) => res.rows);

  return rows.map((row) => {
    row.user = {
      uname: row["user.uname"],
      slug: row["user.slug"],
    };
    delete row["user.uname"];
    delete row["user.slug"];

    row.participants = row["participant_unames"].map((uname, idx) => {
      return {
        uname: uname,
        slug: row["participant_slugs"][idx],
      };
    });
    delete row["participant_unames"];
    delete row["participant_slugs"];

    row.latest_pm = {
      id: row["latest_pm.id"],
      created_at: row["latest_pm.created_at"],
    };
    delete row["latest_pm.id"];
    delete row["latest_pm.created_at"];

    row.latest_user = {
      uname: row["latest_user.uname"],
      slug: row["latest_user.slug"],
    };
    delete row["latest_user.uname"];
    delete row["latest_user.slug"];

    return row;
  });
}

////////////////////////////////////////////////////////////

export async function findParticipantIds(convoId: number) {
  return pool
    .query(
      `
    SELECT user_id
    FROM convos_participants
    WHERE convo_id = $1
      AND deleted_at IS NULL
  `,
      [convoId],
    )
    .then((res) => res.rows)
    .then((xs) => xs.map((x) => x.user_id));
}

////////////////////////////////////////////////////////////

export async function undeleteAllConvos(userId: number) {
  assert(Number.isInteger(userId));

  return pool.query(
    `
    UPDATE convos_participants
    SET deleted_at = NULL
    WHERE user_id = $1
  `,
    [userId],
  );
}

////////////////////////////////////////////////////////////

export async function moveConvos(
  userId: number,
  convoIds: number[],
  folder: string,
) {
  debug(
    `[moveConvos] userId=%j, folder=%j, convoIds=%j`,
    userId,
    folder,
    convoIds,
  );
  assert(Number.isInteger(userId));
  assert(typeof folder === "string");
  assert(Array.isArray(convoIds));

  return pool.query(
    `
    UPDATE convos_participants
    SET folder = $1
    WHERE user_id = $2
      AND convo_id = ANY ($3::int[])
  `,
    [folder, userId, convoIds],
  );
}
