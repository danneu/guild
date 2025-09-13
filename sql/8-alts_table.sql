CREATE TABLE alt_group (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN alt_group_id int NULL REFERENCES alt_group (id);
