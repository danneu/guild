// Issues login sessions. Its own module so that server/db/accounts.ts can
// issue one at signup without importing server/db/index.ts, which re-exports
// it.

import assert from "assert";
import createDebug from "debug";
const debug = createDebug("app:db");
import { Client, Pool, PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
// 1st party
import { DbSession } from "../dbtypes";
import { exactlyOneRow } from "./util";

export async function createSession(
  pgClient: Pool | PoolClient | Client,
  props: {
    userId: number;
    ipAddress: string;
    interval: string;
  },
) {
  debug("[createSession] props: ", props);
  assert(typeof props.userId === "number");
  assert(typeof props.ipAddress === "string");
  assert(typeof props.interval === "string");

  const uuid = uuidv7();

  return pgClient
    .query<DbSession>(
      `
    INSERT INTO sessions (user_id, id, ip_address, expired_at)
    VALUES ($1, $2, $3::inet,
      NOW() + $4::interval)
    RETURNING *
  `,
      [props.userId, uuid, props.ipAddress, props.interval],
    )
    .then(exactlyOneRow);
}
