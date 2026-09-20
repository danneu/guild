-- Phase 1 of plan/2026-08-11-1613 (require email confirmation before writing).
--
-- Additive only: apply this before deploying any code. Redeploying the previous
-- build stays a working rollback because nothing here touches email_verified.
--
-- Two independent stamps, with distinct meanings:
--
--   email_verified_at     this address was confirmed by clicking a link.
--                         Gates writes; gates PM notification mail from phase 3.
--   email_gate_exempt_at  this account is excused from the write gate.
--                         Gates writes; never affects mail.
--
-- Write gate predicate:
--   email_verified_at IS NOT NULL OR email_gate_exempt_at IS NOT NULL
--
-- Two columns rather than one because grandfathering ~20 years of accounts into
-- a single "verified" state would open the mailer filter on long-dead addresses
-- and bounces damage SES sender reputation.
--
-- Both are nullable with no default, so these are catalog-only changes.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz NULL;
ALTER TABLE users ADD COLUMN email_gate_exempt_at timestamptz NULL;

-- At most one token row per user (UNIQUE (user_id)): issuance is a single atomic
-- upsert on that row, so the surviving row is always one complete
-- (token, address) pair and a link mailed to a superseded address stops working.
--
-- email is carried on the token, not on users: the token row *is* the
-- pending-address state. Confirmation writes the address recorded on the token,
-- so the address that gets verified is by construction the address the clicked
-- link was mailed to.
--
-- Deliberately no unique index on email: the address is only *claimed* at
-- confirmation, where unique_email on lower(email) enforces it atomically inside
-- the swap. First-to-confirm wins. A unique index on the staged address would
-- let anyone squat an address they do not own for 24 hours.
CREATE TABLE email_verification_tokens (
  user_id    int  NOT NULL  REFERENCES users(id)  ON DELETE CASCADE,
  token      uuid NOT NULL,
  email      text NOT NULL,
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  expired_at timestamp with time zone NOT NULL  DEFAULT NOW() + INTERVAL '24 hours',
  UNIQUE (user_id)
);

CREATE INDEX email_verification_tokens__token
  ON email_verification_tokens (token);

-- Expiry kills the link, not the staged address: readers of pending state
-- (throttle guard, wall page, profile panel) read the base table, not this view.
CREATE VIEW active_email_verification_tokens AS
  SELECT *
  FROM email_verification_tokens
  WHERE expired_at >= NOW()
;

-- Backfill in batches by id range, committing between chunks. A single
-- full-table UPDATE would contend with the last_online_at write that runs on
-- every authenticated request.
--
-- Each statement is guarded by IS NULL, so the batches are resumable and
-- idempotent. NOW() here is a grandfather stamp, not a claim about when anyone
-- actually confirmed an address.
--
-- The COMMIT inside the block is what makes the batching worth anything, so run
-- this file in autocommit (plain psql), never wrapped in an explicit BEGIN.
DO $$
DECLARE
  batch_size constant int := 5000;
  lo int := 0;
  hi int;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO hi FROM users;
  WHILE lo <= hi LOOP
    UPDATE users
      SET email_verified_at = NOW()
      WHERE id > lo AND id <= lo + batch_size
        AND email_verified
        AND email_verified_at IS NULL;

    UPDATE users
      SET email_gate_exempt_at = NOW()
      WHERE id > lo AND id <= lo + batch_size
        AND NOT email_verified
        AND email_gate_exempt_at IS NULL;

    COMMIT;
    lo := lo + batch_size;
  END LOOP;
END $$;

-- Incident runbook: mail is configured but delivery is failing (SES outage,
-- credentials revoked, sender suspended). Registration still succeeds and lands
-- on the wall page, and the self-service path is the resend button once delivery
-- recovers. For a sustained outage, grant write access in bulk by hand over
-- prod:ssh -- existing column, no deploy:
--
--   UPDATE users SET email_gate_exempt_at = NOW()
--     WHERE email_verified_at IS NULL AND email_gate_exempt_at IS NULL
--       AND created_at BETWEEN '<outage start>' AND '<outage end>';
--
-- This grants writes without marking anything verified, so the mailer predicate
-- is untouched.
