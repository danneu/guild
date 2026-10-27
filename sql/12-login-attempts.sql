-- The login attempt budget's counters (server/db/login_attempts.ts). The
-- limits and the admission rule live in server/auth.ts#authenticate.
--
-- ORDERING IS LOAD-BEARING. Apply this by hand BEFORE deploying the build that
-- reads it. That build charges this table on every POST /sessions, so without
-- it every password login fails with 42P01 (undefined_table). Sessions people
-- already hold keep working.
--
-- Additive only: the previous build never touches this table, so redeploying
-- it stays a working rollback.
--
-- One row per counter. kind says what the key names: 'identifier' is the
-- normalized uname or email typed at login, 'ip' is the client's ip_root
-- network. key_digest is sha256 of that text, so rows are fixed size and never
-- hold a typed email, or a password typed into the wrong field. count is the
-- attempts admitted in the window that ends at window_ends_at; once that has
-- passed, the row counts as zero and the sweep deletes it.

CREATE TABLE login_attempts (
  kind           text         NOT NULL  CHECK (kind IN ('identifier', 'ip')),
  key_digest     bytea        NOT NULL  CHECK (length(key_digest) = 32),
  count          int          NOT NULL  CHECK (count >= 0),
  window_ends_at timestamptz  NOT NULL,
  PRIMARY KEY (kind, key_digest)
);

CREATE INDEX login_attempts__window_ends_at
  ON login_attempts (window_ends_at);
