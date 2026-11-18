// The SQL files that build an empty database's schema, in the order they run.
// reset-db (server/reset_db.ts) loads them and then its seeds. The test
// database (server/testing/db.ts) loads them alone, so tests run on the schema
// a fresh local database has.

import fs from "fs";
import path from "path";

export const SCHEMA_FILES = [
  "1-schema.sql",
  "2-functions_and_triggers.sql",
  "3-drop-plv8.sql",
  "4-better-notif-indexes.sql",
  "5-better-post-hidden-trigger-fn.sql",
];

// A file in sql/ by its name.
export function readSqlFile(name: string): string {
  return fs.readFileSync(path.join(__dirname, "../sql", name), "utf8");
}
