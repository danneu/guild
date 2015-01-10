DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP VIEW IF EXISTS active_sessions;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS forums CASCADE;
DROP TABLE IF EXISTS topics CASCADE;
DROP TABLE IF EXISTS posts CASCADE;
DROP TYPE IF EXISTS role_type;
DROP TABLE IF EXISTS convos CASCADE;
DROP TABLE IF EXISTS pms CASCADE;
DROP TABLE IF EXISTS convos_participants CASCADE;
DROP TYPE IF EXISTS post_type;
DROP TABLE IF EXISTS topic_subscriptions CASCADE;
DROP VIEW IF EXISTS active_reset_tokens;
DROP TABLE IF EXISTS reset_tokens CASCADE;

--
-- Only put things in this file that should be present for the
-- COPY FROM migration.
--

CREATE EXTENSION IF NOT EXISTS plv8;

CREATE TYPE role_type AS ENUM ('admin', 'smod', 'mod', 'member', 'banned');

CREATE TABLE users (
  id             serial PRIMARY KEY,
  uname          text   NOT NULL,  -- Unique index added later in schema
  digest         text   NOT NULL,
  email          text   NOT NULL,  -- Unique index added later in schema
  oldguild_uname text   NULL,
  created_at     timestamp with time zone NOT NULL  DEFAULT NOW(),
  last_online_at timestamp with time zone NULL,
  is_ghost       boolean   NOT NULL  DEFAULT false,
  role           role_type NOT NULL  DEFAULT 'member',
  -- Cache
  posts_count    int       NOT NULL  DEFAULT 0,
  pms_count      int       NOT NULL  DEFAULT 0
);

CREATE UNIQUE INDEX unique_username ON users USING btree (lower(uname));
CREATE UNIQUE INDEX unique_email ON users USING btree (lower(email));

CREATE TABLE reset_tokens (
  user_id int  NOT NULL  REFERENCES users(id)  ON DELETE CASCADE,
  token   uuid NOT NULL,
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  expired_at timestamp with time zone NOT NULL  DEFAULT NOW() + INTERVAL '15 minutes'
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY,
  user_id    int  REFERENCES users(id) ON DELETE CASCADE,
  ip_address inet NOT NULL,
  expired_at timestamp with time zone NOT NULL
                                      DEFAULT NOW() + INTERVAL '1 day',
  created_at timestamp with time zone NOT NULL  DEFAULT NOW()
);

CREATE VIEW active_sessions AS
  SELECT *
  FROM sessions
  WHERE expired_at >= NOW()
;

CREATE VIEW active_reset_tokens AS
  SELECT *
  FROM reset_tokens
  WHERE expired_at >= NOW()
;

CREATE TABLE categories (
  id          serial PRIMARY KEY,
  title       text NOT NULL,
  description text NULL,
  pos         int NOT NULL
);

CREATE TABLE forums (
  id              serial PRIMARY KEY,
  category_id     int NOT NULL  REFERENCES categories(id)  ON DELETE CASCADE,
  parent_forum_id int NULL  REFERENCES forums(id)  ON DELETE SET NULL,
  title           text NOT NULL,
  description     text NULL,
  pos             int NOT NULL,
  is_roleplay     boolean NOT NULL  DEFAULT false,
  -- Cache
  topics_count    int NOT NULL  DEFAULT 0,
  posts_count     int NOT NULL  DEFAULT 0
);

--
-- Topics/Posts system
--

CREATE TABLE topics (
  id         serial PRIMARY KEY,
  title      text NOT NULL,
  user_id    int NOT NULL  REFERENCES users(id)  ON DELETE CASCADE,
  forum_id   int NOT NULL  REFERENCES forums(id)  ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  is_roleplay boolean NOT NULL,
  -- Modkit flags
  is_hidden  boolean NOT NULL  DEFAULT false,
  is_closed  boolean NOT NULL  DEFAULT false,
  is_sticky  boolean NOT NULL  DEFAULT false,
  -- Counter Cache
  posts_count int NOT NULL  DEFAULT 0,
  ic_posts_count int NOT NULL DEFAULT 0,
  ooc_posts_count int NOT NULL DEFAULT 0,
  char_posts_count int NOT NULL DEFAULT 0
);

CREATE TYPE post_type AS ENUM ('ic', 'ooc', 'char');

CREATE TABLE posts (
  id         serial PRIMARY KEY,
  text       text NOT NULL,
  legacy_html text NULL,
  topic_id   int NOT NULL  REFERENCES topics(id)  ON DELETE CASCADE,
  user_id    int NOT NULL  REFERENCES users(id)  ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  updated_at timestamp with time zone NULL,
  is_roleplay boolean NOT NULL,
  type       post_type NOT NULL,
  ip_address inet NULL,
  is_hidden  boolean NOT NULL  DEFAULT false,
  idx         int  NULL
);

CREATE UNIQUE INDEX posts_topic_id_type_idx_idx ON posts (topic_id, type, idx DESC);

-- Last post cache
ALTER TABLE forums ADD COLUMN latest_post_id
  int NULL REFERENCES posts(id)  ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN latest_post_id
  int NULL REFERENCES posts(id)  ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN latest_ic_post_id
  int NULL REFERENCES posts(id)  ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN latest_ooc_post_id
  int NULL REFERENCES posts(id)  ON DELETE SET NULL;
ALTER TABLE topics ADD COLUMN latest_char_post_id
  int NULL REFERENCES posts(id)  ON DELETE SET NULL;

CREATE TABLE topic_subscriptions (
  user_id int NOT NULL  REFERENCES users(id)  ON DELETE CASCADE,
  topic_id int NOT NULL  REFERENCES topics(id)  ON DELETE CASCADE,
  UNIQUE (user_id, topic_id)
);

--
-- Convos/Private-messaging system
--

CREATE TABLE convos (
  id          serial PRIMARY KEY,
  user_id     int    NOT NULL  REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamp with time zone NOT NULL  DEFAULT NOW(),
  title       text   NOT NULL,
  is_archived boolean NOT NULL  DEFAULT false,
  legacy_participant_ids integer[] NULL,
  -- Cache
  pms_count int    NOT NULL  DEFAULT 0
);

CREATE TABLE pms (
  id         serial PRIMARY KEY,
  text       text   NOT NULL,
  legacy_html text NULL,
  convo_id   int    NOT NULL  REFERENCES convos(id)  ON DELETE CASCADE,
  user_id    int    NOT NULL  REFERENCES users(id)  ON DELETE CASCADE,
  ip_address inet   NULL,
  idx        int    NOT NULL,
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  updated_at timestamp with time zone NULL
);

-- Latest PM cache
ALTER TABLE convos ADD COLUMN latest_pm_id
  int NULL REFERENCES pms(id)  ON DELETE SET NULL;

CREATE UNIQUE INDEX pms_convo_id_idx_idx ON pms (convo_id, idx DESC);

CREATE TABLE convos_participants (
  convo_id int NOT NULL  REFERENCES convos(id) ON DELETE CASCADE,
  user_id  int NOT NULL  REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, convo_id)
);

------------------------------------------------------------
------------------------------------------------------------
-- Functions/triggers that should exist for the COPY FROM
-- migration. Everything else should be in
-- functions_and_triggers.sql
------------------------------------------------------------
------------------------------------------------------------
-- Set post idx before inserted

CREATE OR REPLACE FUNCTION set_post_idx() RETURNS trigger AS
$$
  q = 'SELECT COALESCE(MAX(p.idx) + 1, 0) "idx"  '+
      'FROM posts p                              '+
      'WHERE p.topic_id = $1 AND p.type = $2     ';
  var rows = plv8.execute(q, [NEW.topic_id, NEW.type]);
  NEW.idx = rows[0].idx;
  return NEW;
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS trigger_set_post_idx ON posts;
CREATE TRIGGER trigger_set_post_idx
    BEFORE INSERT ON posts
    FOR EACH ROW
    EXECUTE PROCEDURE set_post_idx();

------------------------------------------------------------
------------------------------------------------------------
-- Set pm idx before insertion

CREATE OR REPLACE FUNCTION set_pm_idx() RETURNS trigger AS
$$
  q = 'SELECT COALESCE(MAX(pms.idx) + 1, 0) "idx"  '+
      'FROM pms                                    '+
      'WHERE pms.convo_id = $1                     ';
  var rows = plv8.execute(q, [NEW.convo_id]);
  NEW.idx = rows[0].idx;
  return NEW;
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS trigger_set_pm_idx ON pms;
CREATE TRIGGER trigger_set_pm_idx
    BEFORE INSERT ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE set_pm_idx();
