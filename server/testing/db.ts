// A real Postgres for tests, so a test can check what its SQL does to rows
// rather than match the SQL's text. It is PGlite, Postgres compiled to WASM,
// run inside the test file's own worker: no server, Docker or CI service.
// pglite-socket serves it on a local port, so the app's own pg driver talks to
// it and parses rows as it does in production.
//
// A test file opts in by pointing server/db/util's pool at it, then empties the
// tables before each test and closes the database after the file:
//
//   vi.mock("./util", async (importOriginal) =>
//     (await import("../testing/db")).onTestDatabase(
//       await importOriginal<typeof import("./util")>(),
//     ),
//   );
//   beforeEach(emptyTables);
//   afterAll(closeTestDatabase);
//
// The file gets its own database, built from the schema reset-db loads
// (server/schema_files.ts), and seeds rows through that pool. Seed a time
// relative to the database's now(), so a window is tested on the clock its SQL
// reads. server/db/time_windows.test.ts is the example.
//
// Limits: PGlite serves one session, so the pool holds one connection. Code
// that takes a second connection inside a transaction times out here, and two
// sessions at once, such as two sends racing for an advisory lock, cannot be
// tested. PGlite's Postgres version may differ from production's.

import assert from "assert";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type pg from "pg";

import type * as Util from "../db/util";
import { SCHEMA_FILES, readSqlFile } from "../schema_files";

type TestDatabase = {
  pglite: PGlite;
  server: PGLiteSocketServer;
  pool: pg.Pool;
  // Every table the schema made, for emptyTables
  tables: string[];
};

let database: TestDatabase | undefined;

// The vi.mock factory for server/db/util: the real module, with its pool on a
// new test database.
export async function onTestDatabase(
  actual: typeof Util,
): Promise<typeof Util> {
  assert(!database, "this test file already has a test database");

  const pglite = await PGlite.create();
  for (const file of SCHEMA_FILES) {
    await pglite.exec(readSqlFile(file));
  }
  const { rows } = await pglite.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = rows.map((row) => `"${row.tablename}"`);

  // Port 0 lets the OS pick a free port, so test files in parallel workers
  // never collide.
  const server = new PGLiteSocketServer({ db: pglite, port: 0 });
  const port = new Promise<number>((resolve) => {
    server.addEventListener("listening", (event) => {
      resolve((event as CustomEvent<{ port: number }>).detail.port);
    });
  });
  await server.start();

  const pool = actual.createPool({
    host: "127.0.0.1",
    port: await port,
    user: "postgres",
    database: "postgres",
    // PGlite serves one session
    max: 1,
    // Keep the one connection open. The server takes one at a time, so a new
    // one could be turned away while the server still holds the old one.
    idleTimeoutMillis: 0,
    // Hang guard, below vitest's own test timeout, for a second checkout
    // while the one connection is held.
    connectionTimeoutMillis: 2000,
  });

  database = { pglite, server, pool, tables };
  return { ...actual, pool, default: { ...actual.default, pool } };
}

function current(): TestDatabase {
  assert(
    database,
    "no test database: vi.mock server/db/util with onTestDatabase",
  );
  return database;
}

// Deletes every row and restarts every id sequence, so each test starts from
// the empty schema.
export async function emptyTables(): Promise<void> {
  const { pool, tables } = current();
  await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
}

export async function closeTestDatabase(): Promise<void> {
  const { pglite, server, pool } = current();
  database = undefined;
  await pool.end();
  await server.stop();
  await pglite.close();
}
