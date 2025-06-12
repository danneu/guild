import { pool } from './util.js'
import { sql } from 'pg-extra'

////////////////////////////////////////////////////////////

export const getVmById = async id => {
    return pool.one(sql`
    SELECT
      vms.*,
      (SELECT to_json(users.*) FROM users WHERE id = vms.to_user_id) to_user,
      (SELECT to_json(users.*) FROM users WHERE id = vms.from_user_id) from_user
    FROM vms
    WHERE id = ${id}
  `)
}

////////////////////////////////////////////////////////////

export const deleteVm = async id => {
    return pool.query(sql`
    DELETE FROM vms
    WHERE id = ${id}
  `)
}

////////////////////////////////////////////////////////////

export const deleteVmChildren = async parentId => {
    return pool.query(sql`
    DELETE FROM vms
    WHERE parent_vm_id = ${parentId}
  `)
}

////////////////////////////////////////////////////////////

export const deleteNotificationsForVmId = async id => {
    return pool.query(sql`
    DELETE FROM notifications
    WHERE id = ${id}
  `)
}
