-- Serves the signup network cap's read in
-- server/db/accounts.ts#createUserWithSession: the newest signups from one
-- ip_root network, newest first. With it, that read is a short backward scan
-- of one network's entries.
--
-- ORDERING IS NOT LOAD-BEARING. Apply this by hand before or after deploying
-- the build that reads it. Without it the read is still correct, but each
-- signup scans users while it holds its network's lock.
--
-- Additive only: the previous build never reads it, so redeploying it stays a
-- working rollback.
--
-- CONCURRENTLY, so writes to users go on while it builds. It cannot run in a
-- transaction block, so run it on its own, not under psql --single-transaction.
-- If it fails partway it leaves an INVALID index: DROP INDEX CONCURRENTLY
-- users__registration_network, then run this again.

CREATE INDEX CONCURRENTLY users__registration_network
  ON users (ip_root(registration_ip), created_at)
  WHERE registration_ip IS NOT NULL;
