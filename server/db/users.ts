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

export const getUserByEmail = async (email) => {
  const str = knex("users").where("email", email).first().toString();
  const result = await pool.query(str);
  return result.rows[0];
};

// Generalized update function that takes an object of
// field/values to be updated.
export const updateUser = async function (userId, fields) {
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

export const unapproveUser = async (userId) => {
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

export const approveUser = async ({ approvedBy, targetUser }) => {
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
