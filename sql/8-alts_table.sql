CREATE TABLE alt_groups (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN alt_group_id int NULL REFERENCES alt_groups (id);
