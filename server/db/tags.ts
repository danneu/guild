// 3rd
import assert from "assert";
// 1st
import { pool, maybeOneRow } from "./util";

////////////////////////////////////////////////////////////

export const getTag = async (id: number) => {
  assert(Number.isInteger(id));

  return pool
    .query(
      `
    SELECT *
    FROM tags
    WHERE id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const getGroup = async (id: number) => {
  return pool
    .query(
      `
    SELECT
      tg.*,
      json_agg(tags.*) tags
    FROM tag_groups tg
    LEFT JOIN tags ON tags.tag_group_id = tg.id
    WHERE tg.id = $1
    GROUP BY tg.id
  `,
      [id],
    )
    .then(maybeOneRow)
    .then((x) => {
      if (!x) return null;
      // Turn [null] into [] if no tags
      x.tags = x.tags.filter(Boolean);
      return x;
    });
};

export const listGroups = async () => {
  return pool
    .query(
      `
    SELECT
      tg.*,
      json_agg(tags.*) tags
    FROM tag_groups tg
    LEFT JOIN tags ON tags.tag_group_id = tg.id
    GROUP BY tg.id
    ORDER BY tg.id
  `,
    )
    .then((res) => res.rows)
    .then((xs) =>
      xs.map((x) => {
        // Turn [null] into [] if no tags
        x.tags = x.tags.filter(Boolean);
        return x;
      }),
    );
};

////////////////////////////////////////////////////////////

export const insertTagGroup = async (title: string) => {
  return pool
    .query(
      `
    INSERT INTO tag_groups (title)
    VALUES ($1)
    RETURNING *
  `,
      [title],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const insertTag = async (groupId: number, title: string, desc: string) => {
  assert(Number.isInteger(groupId));
  assert(typeof title === "string");

  return pool
    .query(
      `
    INSERT INTO tags (tag_group_id, title, description)
    VALUES ($1, $2, $3)
    RETURNING *
  `,
      [groupId, title, desc],
    )
    .then(maybeOneRow);
};

////////////////////////////////////////////////////////////

export const moveTag = async (tagId: number, toGroupId: number) => {
  assert(Number.isInteger(tagId));
  assert(Number.isInteger(toGroupId));

  return pool
    .query(
      `
    UPDATE tags
    SET tag_group_id = $1
    WHERE id = $2
  `,
      [toGroupId, tagId],
    )
    .then(maybeOneRow);
};
