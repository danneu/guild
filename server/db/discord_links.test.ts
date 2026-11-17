import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { claimDiscordLink } from "./discord_links";
import { pool } from "./util";

// vitest cannot run Postgres here, so these pin the SQL and the table
// definition; Postgres enforces the key they rely on.
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  pool: { query: vi.fn() },
}));

const repoRoot = path.resolve(__dirname, "../..");

// The CREATE TABLE discord_links statement in a sql/ file
function discordLinksTable(file: string): string {
  const sql = fs.readFileSync(path.join(repoRoot, "sql", file), "utf8");
  const match = /CREATE TABLE discord_links \([^;]*\);/.exec(sql);
  expect(match, `${file} creates discord_links`).not.toBeNull();
  return match![0];
}

describe("claimDiscordLink", () => {
  it("claims with one upsert on the account's key and returns the id the link holds", async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ discord_user_id: "111" }],
    } as never);

    await expect(claimDiscordLink(7, "222")).resolves.toBe("111");

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(
        /INSERT INTO discord_links[\s\S]*ON CONFLICT \(user_id\) DO UPDATE[\s\S]*RETURNING l\.discord_user_id/,
      ),
      [7, "222"],
    );
  });
});

describe("discord_links", () => {
  // Intent: one forum account holds one link, in a fresh database and in
  // production alike.
  // Why it exists: the claim's ON CONFLICT (user_id) needs this key, and
  // reset_db builds from sql/1-schema.sql while production gets the migration.
  it("keys each link on its forum account, in the schema and its migration", () => {
    const schema = discordLinksTable("1-schema.sql");

    expect(discordLinksTable("15-discord-links.sql")).toBe(schema);
    expect(schema).toMatch(/^\s*user_id\s+int\s+PRIMARY KEY\s/m);
  });
});
