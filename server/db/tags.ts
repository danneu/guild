// 3rd
import assert from "assert";
// 1st
import { pool, maybeOneRow, exactlyOneRow } from "./util";
import { DbTag, DbTagGroup } from "../dbtypes";

////////////////////////////////////////////////////////////

export async function getTag(id: number) {
  assert(Number.isInteger(id));

  return pool
    .query<DbTag>(
      `
    SELECT *
    FROM tags
    WHERE id = $1
  `,
      [id],
    )
    .then(maybeOneRow);
}

////////////////////////////////////////////////////////////

export async function getGroup(id: number) {
  return pool
    .query<DbTagGroup & { tags: DbTag[] }>(
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
}

export async function listGroups() {
  return pool
    .query<DbTagGroup & { tags: DbTag[] }>(
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
}

////////////////////////////////////////////////////////////

export const insertTagGroup = async (title: string) => {
  return pool
    .query<DbTagGroup>(
      `
    INSERT INTO tag_groups (title)
    VALUES ($1)
    RETURNING *
  `,
      [title],
    )
    .then(exactlyOneRow);
};

////////////////////////////////////////////////////////////

export async function insertTag({
  groupId,
  title,
  slug,
  desc,
}: {
  groupId: number;
  title: string;
  slug: string;
  desc?: string | void;
}) {
  assert(Number.isInteger(groupId));
  assert(typeof title === "string");
  assert(typeof slug === "string");

  return pool
    .query<DbTag>(
      `
    INSERT INTO tags (tag_group_id, title, slug, description)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `,
      [groupId, title, slug, desc],
    )
    .then(exactlyOneRow);
}

////////////////////////////////////////////////////////////

export const moveTag = async ({
  tagId,
  toGroupId,
}: {
  tagId: number;
  toGroupId: number;
}) => {
  assert(Number.isInteger(tagId));
  assert(Number.isInteger(toGroupId));

  return pool
    .query<DbTag>(
      `
    UPDATE tags
    SET tag_group_id = $1
    WHERE id = $2
    RETURNING *
  `,
      [toGroupId, tagId],
    )
    .then(exactlyOneRow);
};
