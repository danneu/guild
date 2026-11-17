// Node deps
import path from "path";
import fs from "fs";
// 3rd party
import _ from "lodash";
// 1st party
import { NODE_ENV, DATABASE_URL } from "./config";
import { pool } from "./db/util";

if (NODE_ENV !== "development") {
  console.log("can only reset db in development");
  process.exit(1);
}

if (!/localhost/.test(DATABASE_URL)) {
  console.log("can only reset a localhost db");
  process.exit(1);
}

////////////////////////////////////////////////////////////

function slurpSqlSync(filePath: string) {
  const relativePath = "../sql/" + filePath;
  const fullPath = path.join(__dirname, relativePath);
  return fs.readFileSync(fullPath, "utf8");
}

async function resetDb() {
  // Create tables
  console.log("-- 1-schema.sql");
  await (async () => {
    const str = slurpSqlSync("1-schema.sql");
    await pool.query(str);
    console.log("Reset 1-schema.sql");
  })();

  // Triggers: TODO delete this, almost all the fns are moved to 5-drop-plv8.sql
  console.log("-- 2-functions_and_triggers.sql");
  await (async () => {
    const str = slurpSqlSync("2-functions_and_triggers.sql");
    await pool.query(str);
    console.log("Reset 2-functions_and_triggers.sql");
  })();

  // Run drop-plv8.sql
  console.log("-- 3-drop-plv8.sql");
  await (async () => {
    const str = slurpSqlSync("3-drop-plv8.sql");
    await pool.query(str);
    console.log("Reset 3-drop-plv8.sql");
  })();

  // Run 4-better-notif-indexes.sql
  console.log("-- 4-better-notif-indexes.sql");
  await (async () => {
    const str = slurpSqlSync("4-better-notif-indexes.sql");
    await pool.query(str);
    console.log("Reset 4-better-notif-indexes.sql");
  })();

  // Run 5-better-post-hidden-trigger-fn.sql
  console.log("-- 5-better-post-hidden-trigger-fn.sql");
  await (async () => {
    const str = slurpSqlSync("5-better-post-hidden-trigger-fn.sql");
    await pool.query(str);
    console.log("Reset 5-better-post-hidden-trigger-fn.sql");
  })();

  // Seed data
  await (async () => {
    const str = slurpSqlSync("dev_seeds.sql");
    await pool.query(str);
    console.log("Inserted dev_seeds.sql");
  })();

  await (async () => {
    const str = slurpSqlSync("after_seed.sql");
    await pool.query(str);
    console.log("Ran after_seed.sql");
  })();
}

if (!module.parent) {
  // Called from cli
  const succBack = () => {
    console.log("Database reset!");
    process.exit();
  };
  const errBack = (err: any) => {
    console.error("Caught error: ", err, err.stack);
  };
  console.log("Resetting the database...");
  resetDb().then(succBack, errBack);
}
