-- Serves the roll row budget's read in server/db/row_budget.ts#admitRow: one
-- member's newest rolls from the trailing hour. Without it, each roll scans
-- the rolls table while it holds its roller's lock.
--
-- ORDERING IS NOT LOAD-BEARING. Apply this by hand before or after deploying
-- the build that reads it. Without it the read is still correct, only slow.
--
-- Additive only: the previous build never reads it, so redeploying it stays a
-- working rollback.
--
-- CONCURRENTLY, so rolls go on while it builds. It cannot run in a
-- transaction block, so run it on its own, not under psql --single-transaction.
-- If it fails partway it leaves an INVALID index: DROP INDEX CONCURRENTLY
-- rolls__user_id_created_at, then run this again.

CREATE INDEX CONCURRENTLY rolls__user_id_created_at
  ON rolls (user_id, created_at);
