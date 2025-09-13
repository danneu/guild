// 3rd
// import createDebug from 'debug'
// const debug = createDebug('app:db:dice')
import assert from "assert";
import Knex from "knex";
const knex = Knex({ client: "pg" });
import _ from "lodash";
// 1st
import { pool } from "./util.js";

// Note: The db/*.js files are an ongoing effort to
// split apart the db/index.js monolith.

////////////////////////////////////////////////////////////

export const getUserByEmail = async (email: string) => {
  const str = knex("users").where("email", email).first().toString();
  const result = await pool.query(str);
  return result.rows[0];
};

// Generalized update function that takes an object of
// field/values to be updated.
export const updateUser = async function (userId: number, fields: Record<string, any>) {
  assert(Number.isInteger(userId));
  assert(_.isPlainObject(fields));
  // Validate fields
  const WHITELIST = ["gender", "email_verified"];
  Object.keys(fields).forEach((key) => {
    if (WHITELIST.indexOf(key) === -1) {
      throw new Error("FIELD_NOT_WHITELISTED");
    }
  });
  // Build SQL string
  const str = knex("users").where({ id: userId }).update(fields).toString();
  return pool.query(str);
};

////////////////////////////////////////////////////////////

export const unapproveUser = async (userId: number) => {
  assert(Number.isInteger(userId));

  return pool.query(
    `
    UPDATE users
    SET approved_by_id = NULL,
        approved_at = NULL
    WHERE id = $1
  `,
    [userId],
  );
};

////////////////////////////////////////////////////////////

export const approveUser = async ({ approvedBy, targetUser }: { approvedBy: number; targetUser: number }) => {
  assert(Number.isInteger(approvedBy));
  assert(Number.isInteger(targetUser));

  return pool.query(
    `
    UPDATE users
    SET approved_by_id = $1,
        approved_at = NOW()
    WHERE id = $2
  `,
    [approvedBy, targetUser],
  );
};

////////////////////////////////////////////////////////////

//Updates alts table: First guarantees that the user is part of an alts pool (creating a pool and assigning it to the user if not) then merges the second account and all other accounts in its pool with the first.
export const linkUserAlts = async function(userId: number, altId: number) {
  return pool.query(`
    WITH current_group AS (
      SELECT alt_group_id FROM users WHERE id = $1
    ),
    new_group AS (
      INSERT INTO alt_groups
      SELECT
      WHERE (SELECT alt_group_id FROM current_group) IS NULL
      RETURNING id
    ),
    updated_user AS (
      UPDATE users
      SET alt_group_id = COALESCE(
        (SELECT alt_group_id FROM current_group),
        (SELECT id FROM new_group)
      )
      WHERE id = $1
      RETURNING alt_group_id
    )
    UPDATE users
    SET alt_group_id = (SELECT alt_group_id FROM updated_user)
    WHERE id = $2 OR alt_group_id = (SELECT alt_group_id FROM users WHERE id = $2);
  `, [userId, altId]);
};

////////////////////////////////////////////////////////////
//When a user unlinks their account, it removes it from the alt pool but leaves the rest of the pool intact.
export const unlinkUserAlts = async function(userId: number) {
  return pool.query(`
    UPDATE users
    SET alt_group_id = NULL
    WHERE id = $1`,
    [userId]
  );
};
