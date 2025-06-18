import { DbUser, DbVm } from "../dbtypes.js";
import { pool, maybeOneRow } from "./util.js";

////////////////////////////////////////////////////////////

export async function getVmById(id: number) {
  return pool
    .query<DbVm & { to_user: DbUser; from_user: DbUser }>(
      `
    SELECT
      vms.*,
      (SELECT to_json(users.*) FROM users WHERE id = vms.to_user_id) to_user,
      (SELECT to_json(users.*) FROM users WHERE id = vms.from_user_id) from_user
    FROM vms
    WHERE id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function deleteVm(id: number) {
  return pool.query(
    `
    DELETE FROM vms
    WHERE id = $1
  `,
    [id],
  );
}

////////////////////////////////////////////////////////////

export async function deleteVmChildren(parentId: number) {
  return pool.query(
    `
    DELETE FROM vms
    WHERE parent_vm_id = $1
  `,
    [parentId],
  );
}

////////////////////////////////////////////////////////////

export async function deleteNotificationsForVmId(id: number) {
  return pool.query(
    `
    DELETE FROM notifications
    WHERE vm_id = $1
  `,
    [id],
  );
}
