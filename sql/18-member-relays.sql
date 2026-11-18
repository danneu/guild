-- One row per member and kind of member relay: a note to Discord about a
-- member's own action, such as the #general welcome for an Introduce Yourself
-- topic. server/db/member_relays.ts#claimRelay inserts the claim before
-- server/services/discord.ts#relayOnce posts anything, so the primary key
-- lets each member relay each kind once, and the (kind, created_at) index
-- counts a kind's claims against its hourly ceiling.
--
-- ORDERING IS LOAD-BEARING. Apply this by hand BEFORE deploying the build that
-- reads it. That build claims a row before every member relay, so without
-- this table every relay fails with 42P01 (undefined_table) and is lost. Relays
-- run after the response and their errors are logged, so the rest of the site
-- is unaffected.
--
-- Additive only: the previous build never touches this table, so redeploying
-- it stays a working rollback.
--
-- Logged, not UNLOGGED: a crash that emptied it would let every member relay
-- each kind again.
--
-- Rows whose kind ends in ':paused' are not claims. Each records when staff
-- were last told that a kind's relays are held over its ceiling, and user_id
-- is the member whose claim passed it. claimRelay owns both.
--
-- The INSERT below fills in an intro claim for each member who already has a
-- topic in forum 2 (Introduce Yourself), so their next intro is not welcomed
-- again. It writes only new rows. Each is dated at the member's first intro
-- topic, so a filled-in claim counts toward the ceiling only while that topic
-- is under an hour old. Running the whole file again after the deploy is safe,
-- and picks up intros the previous build relayed in between. The other kinds
-- need no fill-in: the first-conversation relay still reads the convos table,
-- and a first post or a newly set bio can relay at most once more per member.
-- server/db/member_relays.test.ts runs this file on real rows.

CREATE TABLE IF NOT EXISTS member_relays (
  user_id     int          NOT NULL  REFERENCES users(id) ON DELETE CASCADE,
  kind        text         NOT NULL,
  created_at  timestamptz  NOT NULL,
  PRIMARY KEY (user_id, kind)
);

CREATE INDEX IF NOT EXISTS member_relays__kind_created_at
  ON member_relays (kind, created_at);

INSERT INTO member_relays (user_id, kind, created_at)
SELECT user_id, 'intro', min(created_at)
FROM topics
WHERE forum_id = 2
GROUP BY user_id
ON CONFLICT (user_id, kind) DO NOTHING;
