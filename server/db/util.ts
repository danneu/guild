import { QueryConfig, QueryResult, QueryResultRow } from "pg"

import pg from 'pg'
const config = require('../config')
const belt = require('../belt')
import { assert } from '../util.js'
import { readFileSync } from 'fs'
import path from 'path'

const rdsRootCert = readFileSync(path.join(__dirname, '../../us-east-1-bundle.pem'), 'utf8')

const connectionConfig: pg.ClientConfig = {
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_URL.includes('localhost') ? false : {
    rejectUnauthorized: true,
    ca: rdsRootCert
  }
}

// TODO: Update db/index.js to use this module,
//       and remove all those dead functions

// This is the connection pool the rest of our db namespace
// should import and use
export const pool = new pg.Pool(connectionConfig)


// These versions work with both datablan/pg and pg's query results.
export function maybeOneRow<T extends QueryResultRow>(result: QueryResult<T>): T | undefined {
  assert(
    result.rows.length <= 1,
    `Expected at most one row, got ${result.rows.length} rows`
  );
  return result.rows[0];
}

export function exactlyOneRow<T extends QueryResultRow>(result: QueryResult<T>): T {
  assert(
    result.rows.length === 1,
    `Expected exactly one row, got ${result.rows.length} rows`
  );
  return result.rows[0]!;
}

// for compat with existing code
// todo: replace all the pool.one with pool.query().then(maybeOneRow)
declare module 'pg' {
  interface Pool {
    one<T extends QueryResultRow = any>(
      queryTextOrConfig: string | QueryConfig<any[]>,
      values?: any[]
    ): Promise<T | undefined>;

    many<T extends QueryResultRow = any>(
      queryTextOrConfig: string | QueryConfig<any[]>,
      values?: any[]
    ): Promise<T[]>;

    withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  }
  
  interface Client {
    one<T extends QueryResultRow = any>(
      queryTextOrConfig: string | QueryConfig<any[]>,
      values?: any[]
    ): Promise<T | undefined>;
  }

  interface PoolClient {
    one<T extends QueryResultRow = any>(
      queryTextOrConfig: string | QueryConfig<any[]>,
      values?: any[]
    ): Promise<T | undefined>;
  }
}


pg.Pool.prototype.one = function<T extends QueryResultRow = any>(
  queryTextOrConfig: string | QueryConfig<any[]>,
  values?: any[]
): Promise<T | undefined> {
  return (this as pg.Pool).query<T>(queryTextOrConfig, values).then(maybeOneRow);
};

pg.Pool.prototype.many = function<T extends QueryResultRow = any>(
  queryTextOrConfig: string | QueryConfig<any[]>,
  values?: any[]
): Promise<T[]> {
  return (this as pg.Pool).query<T>(queryTextOrConfig, values).then(result => result.rows);
};

pg.Pool.prototype.withTransaction = function<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withPgPoolTransaction(this, fn)
}

pg.Client.prototype.one = function<T extends QueryResultRow = any>(
  queryTextOrConfig: string | QueryConfig<any[]>,
  values?: any[]
): Promise<T | undefined> {
  return (this as pg.Client).query<T>(queryTextOrConfig, values).then(maybeOneRow);
};

function getClient() {
    return new pg.Client(connectionConfig)
}

// TODO: Get rid of db/index.js' wrapOptionalClient and use this
function wrapOptionalClient(fn: any) {
    return async function() {
        const args = Array.prototype.slice.call(arguments, 0)
        if (belt.isDBClient(args[0])) {
            return fn.apply(null, args)
        } else {
            return pool.withTransaction(async client => {
                return fn.apply(null, [client, ...args])
            })
        }
    }
}

module.exports = { pool, getClient, wrapOptionalClient }

// TODO: retry logic, explain error (deadlock, etc)
export async function withPgPoolTransaction<T>(
  pool: InstanceType<typeof pg.Pool>,
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T>{
  const client = await pool.connect()
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}