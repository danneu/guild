CREATE TABLE alts (
  id         integer     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  owner_id   integer     NOT NULL REFERENCES users(id),
  created_at timestamptz  NOT NULL DEFAULT NOW()
);

-- There's already an index on primary keys but lets add one for the foreign key.
CREATE INDEX idx_alts_owner_id ON alts(owner_id);

-- Initialize with existing users
INSERT INTO alts (id, owner_id)
SELECT id, id
FROM users
