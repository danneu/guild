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

export const fetchSubforumBansByUserId = async function(userId: number) {
  return pool.query(`
    SELECT subforum_id FROM subforum_bans
    WHERE user_id = $1`,
    [userId]
  ).then(res => res.rows.map(row => row.subforum_id));
};

////////////////////////////////////////////////////////////

//When a mod sets a series of subforum bans, it's easiest to just clear the bans and reset them.
export const setSubforumBans = async function(userId: number, subforum_ids: number[]) {
  //The below generates a safe string with an ID for every index in subforum_ids (index being 0, 1, 2... not the ID itself)
  //Generates ($1, $2), ($1, $3) and so on so we can ban the user from all the target subforums in one fell swoop
  const values = subforum_ids.map((_, i) => `($1, $${i + 2})`).join(', ');
  const params = [userId, ...subforum_ids];
  await pool.query(`
    DELETE FROM subforum_bans
    WHERE user_id = $1`,
    [userId]
  );
  
  if (subforum_ids.length === 0) return;
  
  return pool.query(`
    INSERT INTO subforum_bans (user_id, subforum_id)
    VALUES ${values}`,
    params
  );
};
