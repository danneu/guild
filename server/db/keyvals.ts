"use strict";
// 3rd
import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db:keyvals");
// 1st
import { pool, maybeOneRow } from "./util";
import * as pre from "../presenters";

export async function deleteKey(key: string) {
  assert(typeof key === "string");

  return pool.query(
    `
    DELETE FROM keyvals
    WHERE key = $1
  `,
    [key],
  );
}

// String -> keyvals record object
export async function getRowByKey(key: string) {
  debug(`[getRowByKey] key=${key}`);
  assert(typeof key === "string");
  const row = await pool
    .query(
      `
    SELECT
      *,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "updated_by"
    FROM keyvals
    LEFT OUTER JOIN users ON keyvals.updated_by_id = users.id
    WHERE key = $1
  `,
      [key],
    )
    .then(maybeOneRow);

  pre.presentKeyval(row);

  return row;
}

// String -> Undefined | JSValue
export async function getValueByKey(key: string) {
  assert(typeof key === "string");
  const row = await getRowByKey(key);
  return row && row.value;
}

// updatedById (Optional Int): user_id that's updating the row
export async function setKey(key: string, value: any, updatedById: number) {
  debug("[setKey] key=%j, value=%j, updatedById=%j", key, value, updatedById);
  assert(typeof key === "string");

  if (typeof value !== "string") {
    value = JSON.stringify(value);
  }

  return pool.query(
    `
    INSERT INTO keyvals (key, value, updated_at, updated_by_id)
    VALUES ($1, $2, NOW(), $3)
    ON CONFLICT (key) DO UPDATE
    SET value = $2,
        updated_at = NOW(),
        updated_by_id = $3
    WHERE keyvals.key = $1
  `,
    [key, value, updatedById],
  );
}
