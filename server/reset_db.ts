// 1st party
import { NODE_ENV, DATABASE_URL } from "./config";
import { pool } from "./db/util";
import { SCHEMA_FILES, readSqlFile } from "./schema_files";

if (NODE_ENV !== "development") {
  console.log("can only reset db in development");
  process.exit(1);
}

if (!/localhost/.test(DATABASE_URL)) {
  console.log("can only reset a localhost db");
  process.exit(1);
}

////////////////////////////////////////////////////////////

async function resetDb() {
  // Create tables, functions and triggers
  for (const file of SCHEMA_FILES) {
    console.log(`-- ${file}`);
    await pool.query(readSqlFile(file));
    console.log(`Reset ${file}`);
  }

  // Seed data
  await pool.query(readSqlFile("dev_seeds.sql"));
  console.log("Inserted dev_seeds.sql");

  await pool.query(readSqlFile("after_seed.sql"));
  console.log("Ran after_seed.sql");
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
