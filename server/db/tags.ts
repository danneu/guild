// 3rd
import assert from 'assert'
import { sql } from 'pg-extra'
// 1st
import { pool } from './util'

////////////////////////////////////////////////////////////

export const getTag = async id => {
    assert(Number.isInteger(id))

    return pool.one(sql`
    SELECT *
    FROM tags
    WHERE id = ${id}
  `)
}

////////////////////////////////////////////////////////////

export const getGroup = async id => {
    return pool
        .one(
            sql`
    SELECT
      tg.*,
      json_agg(tags.*) tags
    FROM tag_groups tg
    LEFT JOIN tags ON tags.tag_group_id = tg.id
    WHERE tg.id = ${id}
    GROUP BY tg.id
  `
        )
        .then(x => {
            if (!x) return null
            // Turn [null] into [] if no tags
            x.tags = x.tags.filter(Boolean)
            return x
        })
}

export const listGroups = async () => {
    return pool
        .many(
            sql`
    SELECT
      tg.*,
      json_agg(tags.*) tags
    FROM tag_groups tg
    LEFT JOIN tags ON tags.tag_group_id = tg.id
    GROUP BY tg.id
    ORDER BY tg.id
  `
        )
        .then(xs =>
            xs.map(x => {
                // Turn [null] into [] if no tags
                x.tags = x.tags.filter(Boolean)
                return x
            })
        )
}

////////////////////////////////////////////////////////////

export const insertTagGroup = async title => {
    return pool.one(sql`
    INSERT INTO tag_groups (title)
    VALUES (${title})
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

export const insertTag = async (groupId, title, desc) => {
    assert(Number.isInteger(groupId))
    assert(typeof title === 'string')

    return pool.one(sql`
    INSERT INTO tags (tag_group_id, title, description)
    VALUES (${groupId}, ${title}, ${desc})
    RETURNING *
  `)
}

////////////////////////////////////////////////////////////

export const moveTag = async (tagId, toGroupId) => {
    assert(Number.isInteger(tagId))
    assert(Number.isInteger(toGroupId))

    return pool.one(sql`
    UPDATE tags
    SET tag_group_id = ${toGroupId}
    WHERE id = ${tagId}
  `)
}
