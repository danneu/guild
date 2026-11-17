-- The ledger for the per-account screening budget
-- (server/db/screen_budget.ts). Each write that pays for a spam classifier
-- call writes one row here, in the same transaction as the write.
--
-- ORDERING IS LOAD-BEARING. Apply this by hand BEFORE deploying the build that
-- reads it. That build charges every new topic, post, post edit and retitle by
-- a member the spam check does not trust, so without this table each of them
-- fails with 42P01 (undefined_table). Trusted members never touch it.
--
-- Additive only: the previous build never touches this table, so redeploying
-- it stays a working rollback.
--
-- UNLOGGED like send_spends: a crash empties it, which only resets budgets.
-- server/db/screen_budget.ts#spendScreening deletes each account's expired
-- rows by id, so the table stays small. It always writes created_at itself,
-- from the clock it decided with.

CREATE UNLOGGED TABLE screen_spends (
  id         bigserial    PRIMARY KEY,
  user_id    int          NOT NULL  REFERENCES users(id) ON DELETE CASCADE,
  cost       int          NOT NULL  CHECK (cost > 0),
  created_at timestamptz  NOT NULL
);

CREATE INDEX screen_spends__user_id_created_at
  ON screen_spends (user_id, created_at);
