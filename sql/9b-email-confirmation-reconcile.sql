-- Phase 2 of plan/2026-08-11-1613 (require email confirmation before writing):
-- the reconciliation sweep.
--
-- Numbered 9b because this is not a schema change and not a separate phase: it
-- is the data half of the phase-1/phase-2 cutover that sql/9-email-confirmation.sql
-- began, and it must be applied between 9 and 10.
--
-- WHEN TO RUN. Phase 2 is five ordered steps:
--
--   1. pause registration (REGISTRATION_ENABLED keyval; no deploy needed)
--   2. deploy the gate build
--   3. wait for the old build to fully drain
--   4. run THIS FILE
--   5. re-enable registration
--
-- Do not run it before the old build has drained: the old build clears
-- email_verified on every address change, so a sweep that races it can leave a
-- stamp the old build then invalidates. Do not re-enable registration before it
-- has run: statement (3) grandfathers every still-unstamped account, and the
-- pause is what guarantees that population is entirely pre-rollout rather than
-- fresh signups that ought to confirm.
--
-- HOW TO RUN. Autocommit, same as 9:
--
--   psql -f 9b-email-confirmation-reconcile.sql
--
-- BEFORE RUNNING, pin two placeholders as literals (e.g. '2026-08-20 14:03:00+00'):
--   <timestamp of the deploy>            in statement (2)
--   <timestamp registration was paused>  in statement (3)
-- The file will not run with the placeholders in place -- that is deliberate,
-- the values must be pinned by hand and stay fixed across re-runs.
--
-- Phases 1 and 2 run in ONE sitting (see the plan's Rollout): the deployed build
-- reads only email_verified_at and never writes email_verified, so the gap
-- between the phase-1 backfill and this sweep must be minutes.
--
-- IDEMPOTENT. All three statements are re-runnable:
--   (1) is guarded by email_verified_at IS NULL, so a second pass matches nothing.
--   (2) is guarded by email_verified_at IS NOT NULL and clears it, so a second
--       pass matches nothing; COALESCE preserves an exemption already granted.
--       Its deploy-timestamp cutoff is a fixed literal, so stamps written by
--       the new build (which does not set the boolean) are never cleared.
--   (3) is guarded by both columns being NULL, and its created_at cutoff is a
--       fixed literal pinned at the pause -- not NOW() -- so a later re-run
--       cannot widen the set and grandfather accounts created after the cutover.
--
-- Three kinds of row. Collapsing any two of them is wrong; see the plan's
-- Rollout section for why each is load-bearing.

-- 1. Reconcile: anyone the old build verified after their phase-1 batch.
UPDATE users SET email_verified_at = NOW()
  WHERE email_verified AND email_verified_at IS NULL;
-- 2. Repair: a stale backfill stamp on an address the old build replaced.
--    Stamps written after the deploy came from the new build, which does not
--    write the boolean; keep those (plan AR5).
UPDATE users SET email_verified_at = NULL,
                 email_gate_exempt_at = COALESCE(email_gate_exempt_at, NOW())
  WHERE NOT email_verified AND email_verified_at IS NOT NULL
    AND email_verified_at < '<timestamp of the deploy>';
-- 3. Grandfather the still-unverified remainder: everything that existed while
--    registration was paused.
UPDATE users SET email_gate_exempt_at = NOW()
  WHERE email_verified_at IS NULL AND email_gate_exempt_at IS NULL
    AND created_at < '<timestamp registration was paused>';

-- AFTERWARDS, confirm the sweep left the two representations in agreement --
-- sql/10-drop-email-verified.sql requires this to return 0:
--
--   SELECT count(*) FROM users WHERE email_verified <> (email_verified_at IS NOT NULL);
