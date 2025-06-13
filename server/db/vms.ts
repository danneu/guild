import { pool, maybeOneRow } from './util.js'

////////////////////////////////////////////////////////////

export const getVmById = async id => {
    return pool.query(`
    SELECT
      vms.*,
      (SELECT to_json(users.*) FROM users WHERE id = vms.to_user_id) to_user,
      (SELECT to_json(users.*) FROM users WHERE id = vms.from_user_id) from_user
    FROM vms
    WHERE id = $1
  `, [id]).then(maybeOneRow)
}

////////////////////////////////////////////////////////////

export const deleteVm = async id => {
    return pool.query(`
    DELETE FROM vms
    WHERE id = $1
  `, [id])
}

////////////////////////////////////////////////////////////

export const deleteVmChildren = async parentId => {
    return pool.query(`
    DELETE FROM vms
    WHERE parent_vm_id = $1
  `, [parentId])
}

////////////////////////////////////////////////////////////

export const deleteNotificationsForVmId = async id => {
    return pool.query(`
    DELETE FROM notifications
    WHERE id = $1
  `, [id])
}
