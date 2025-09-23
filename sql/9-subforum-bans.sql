CREATE TABLE subforum_bans (
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subforum_id int NOT NULL REFERENCES forums(id) ON DELETE CASCADE
);
