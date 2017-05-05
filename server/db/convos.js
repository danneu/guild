// 3rd
const assert = require('better-assert');
const _ = require('lodash');
const debug = require('debug')('app:db:convos')
// 1st
const config = require('../config')
const {pool} = require('./util')
const {sql} = require('pg-extra')

////////////////////////////////////////////////////////////

exports.getConvo = async (id) => {
  assert(id)
  return exports.getConvos([id]).then(([x]) => x)
}

exports.getConvos = async (ids) => {
  debug('[getConvos] ids=%j', ids)
  assert(Array.isArray(ids))

  return pool.many(sql`
    SELECT
      c.*,
      to_json(u1.*) "user",
      to_json(array_agg(u2.*)) "participants",
      json_agg(cp.*) "cp"
    FROM convos c
    JOIN convos_participants cp ON c.id = cp.convo_id AND deleted_at IS NULL
    JOIN users u1 ON c.user_id = u1.id
    JOIN users u2 ON cp.user_id = u2.id
    WHERE c.id = ANY (${ids}::int[])
    GROUP BY c.id, u1.id
  `)
}

////////////////////////////////////////////////////////////

exports.deleteTrash = async function (userId) {
  return pool.query(sql`
    UPDATE convos_participants
    SET deleted_at = NOW()
    WHERE user_id = ${userId}
      AND folder = 'TRASH'
  `)
}

////////////////////////////////////////////////////////////

exports.deleteConvos = async (userId, convoIds) => {
  debug(`[deleteConvos] userId=%j, convoIds=%j`, userId, convoIds)
  assert(Number.isInteger(userId))
  assert(Array.isArray(convoIds))

  return pool.query(sql`
    UPDATE convos_participants
    SET deleted_at = NOW()
    WHERE user_id = ${userId}
      AND convo_id = ANY (${convoIds}::int[])
  `)
}

////////////////////////////////////////////////////////////

exports.getConvoFolderCounts = async function (userId) {
  assert(Number.isInteger(userId))

  return pool.one(sql`
    SELECT
      COUNT(*) FILTER (WHERE folder = 'INBOX') "inbox_count",
      COUNT(*) FILTER (WHERE folder = 'STAR') "star_count",
      COUNT(*) FILTER (WHERE folder = 'ARCHIVE') "archive_count",
      COUNT(*) FILTER (WHERE folder = 'TRASH') "trash_count"
    FROM convos_participants
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
  `)
}

////////////////////////////////////////////////////////////

exports.findConvosInvolvingUserId = async function (userId, folder, page) {
  assert(_.isNumber(page))
  assert(['INBOX', 'STAR', 'ARCHIVE', 'TRASH'].includes(folder))

  const offset = config.CONVOS_PER_PAGE * (page-1)
  const limit = config.CONVOS_PER_PAGE

  const rows = await pool.many(sql`
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
  AND (cp2.folder = ${folder} AND cp2.user_id = ${userId})
GROUP BY c.id, u1.id, pms.id, u3.id, cp2.folder
ORDER BY c.latest_pm_id DESC
OFFSET ${offset}
LIMIT ${limit}
  `)

  return rows.map((row) => {
    row.user = {
      uname: row['user.uname'],
      slug: row['user.slug']
    }
    delete row['user.uname']
    delete row['user.slug']

    row.participants = row['participant_unames'].map((uname, idx) => {
      return {
        uname: uname,
        slug: row['participant_slugs'][idx]
      }
    })
    delete row['participant_unames']
    delete row['participant_slugs']

    row.latest_pm = {
      id: row['latest_pm.id'],
      created_at: row['latest_pm.created_at']
    }
    delete row['latest_pm.id']
    delete row['latest_pm.created_at']

    row.latest_user = {
      uname: row['latest_user.uname'],
      slug: row['latest_user.slug']
    }
    delete row['latest_user.uname']
    delete row['latest_user.slug']

    return row
  })
}

////////////////////////////////////////////////////////////

exports.findParticipantIds = async function (convoId) {
  return pool.many(sql`
    SELECT user_id
    FROM convos_participants
    WHERE convo_id = ${convoId}
      AND deleted_at IS NULL
  `).then((xs) => xs.map((x) => x.user_id))
}
