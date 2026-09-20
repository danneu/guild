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

// Generalized update function that takes an object of
// field/values to be updated.
export const updateUser = async function (
  userId: number,
  fields: Record<string, any>,
) {
  assert(Number.isInteger(userId));
  assert(_.isPlainObject(fields));
  // Validate fields
  const WHITELIST = ["gender"];
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

export const approveUser = async ({
  approvedBy,
  targetUser,
}: {
  approvedBy: number;
  targetUser: number;
}) => {
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
