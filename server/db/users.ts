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

//Updates alts table: looks up the row with the alt's ID, then finds its owner ID, then updates all rows with the same owner ID. This merges two alt chains into one.
//SET: Grabs the owner_id of the user registering the alt (in case they're an alt of some other account)
//WHERE: Everyone owned by the same account as the current alt
export const linkUserAlts = async function(userId, altId) {
  return pool.query(`
    UPDATE alts
    SET owner_id = (SELECT owner_id from alts WHERE id=$1)
    WHERE owner_id = (SELECT owner_id FROM alts WHERE id = $2)`,
    [userId, altId]);
};

////////////////////////////////////////////////////////////
//First runs a query to find all accounts owned by the unlinked account. It sets the owner of all of those accounts to one of the other accounts in the pool (since there's no legit hierarchy)
//Then we set the ID of the unlinked account to itself, marking it as unowned. And due to the previous query, it won't be part of any pool.
export const unlinkUserAlts = async function(userId) {
  await pool.query(`
    UPDATE alts
    SET owner_id = (
      SELECT MIN(id)
      FROM alts
      WHERE owner_id = $1
      AND id <> $1
    )
    WHERE owner_id = $1 AND id <> $1`,
    [userId]
  );

  return pool.query(`
    UPDATE alts
    SET owner_id = $1
    WHERE id=$1`,
    [userId]
  );
};
