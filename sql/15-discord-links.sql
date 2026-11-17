-- The Discord account each forum account added to the Discord server
-- (server/db/discord_links.ts). server/discord/join.ts#joinDiscord claims a
-- row before it adds anyone, and refuses a Discord id other than the one the
-- row holds. The row is also the only record of which forum account added a
-- Discord member, since members can change their own nick.
--
-- ORDERING IS LOAD-BEARING. Apply this by hand BEFORE deploying the build that
-- reads it. That build claims a row on every new join, so without this table
-- every join fails with 42P01 (undefined_table) and shows "Something went
-- wrong while joining Discord". The rest of the site is unaffected.
--
-- Additive only: the previous build never touches this table, so redeploying
-- it stays a working rollback. Accounts that joined before it have no row.
--
-- Logged, not UNLOGGED: a crash that emptied it would let every account add
-- another Discord account.
--
-- Staff exception: a member who switches Discord accounts asks staff, who
-- delete the row (DELETE FROM discord_links WHERE user_id = ...). Nothing
-- removes the old Discord account from the server, so after a clear one
-- forum account has added two. The table holds one Discord account per forum
-- account at a time, not over the account's life.

CREATE TABLE discord_links (
  user_id          int          PRIMARY KEY  REFERENCES users(id) ON DELETE CASCADE,
  discord_user_id  text         NOT NULL  CHECK (discord_user_id ~ '^[0-9]+$'),
  created_at       timestamptz  NOT NULL  DEFAULT NOW()
);
