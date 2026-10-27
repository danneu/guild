-- The ledger for the per-account send budget (server/db/send_budget.ts). Each
-- member send writes one row here, in the same transaction as the send.
--
-- ORDERING IS LOAD-BEARING. Apply this by hand BEFORE deploying the build that
-- reads it. That build spends inside every member send, so without this table
-- every member send fails with 42P01 (undefined_table), and the PM system
-- stops working.
--
-- Additive only: the previous build never touches this table, so redeploying
-- it stays a working rollback.
--
-- UNLOGGED like ratelimits: a crash empties it, which only resets budgets.
-- server/db/send_budget.ts#spend deletes each sender's expired rows, so the
-- table stays small.

CREATE UNLOGGED TABLE send_spends (
  user_id    int          NOT NULL  REFERENCES users(id) ON DELETE CASCADE,
  cost       int          NOT NULL  CHECK (cost > 0),
  created_at timestamptz  NOT NULL  DEFAULT NOW()
);

CREATE INDEX send_spends__user_id_created_at
  ON send_spends (user_id, created_at);
