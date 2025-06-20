-- Adds a unames.updated_at column so we can track when a username was reused
-- vs. created for the first time.

-- Add updated_at column to unames table
ALTER TABLE unames ADD COLUMN updated_at timestamptz;

-- Set existing records' updated_at to their created_at
UPDATE unames SET updated_at = created_at;

-- Now make the column NOT NULL with a default
ALTER TABLE unames
ALTER COLUMN updated_at
SET
    NOT NULL,
ALTER COLUMN updated_at
SET DEFAULT NOW();