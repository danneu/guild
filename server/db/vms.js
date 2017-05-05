// 3rd
const assert = require('better-assert')
// 1st
const {pool} = require('./util')
const {sql} = require('pg-extra')

////////////////////////////////////////////////////////////

exports.getVmById = async (id) => {
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

exports.deleteVm = async (id) => {
  return pool.query(sql`
    DELETE FROM vms
    WHERE id = ${id}
  `)
}

////////////////////////////////////////////////////////////

exports.deleteVmChildren = async (parentId) => {
  return pool.query(sql`
    DELETE FROM vms
    WHERE parent_vm_id = ${parentId}
  `)
}

////////////////////////////////////////////////////////////

exports.deleteNotificationsForVmId = async (id) => {
  return pool.query(sql`
    DELETE FROM notifications
    WHERE id = ${id}
  `)
}
