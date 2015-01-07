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

CREATE EXTENSION IF NOT EXISTS plv8;

CREATE TYPE role_type AS ENUM ('admin', 'smod', 'mod', 'member', 'banned');

CREATE TABLE users (
  id             serial PRIMARY KEY,
  uname          text NOT NULL,  -- Unique index added later in schema
  digest         text NOT NULL,
  email          text NOT NULL,  -- Unique index added later in schema
  oldguild_uname text NULL,
  created_at     timestamp with time zone NOT NULL  DEFAULT NOW(),
  last_online_at timestamp with time zone NOT NULL,
  is_ghost       boolean NOT NULL  DEFAULT false,
  role           role_type NOT NULL  DEFAULT 'member',
  posts_count    int NOT NULL  DEFAULT 0,
  pms_count      int NOT NULL  DEFAULT 0
);

CREATE UNIQUE INDEX unique_username ON users USING btree (lower(uname));
CREATE UNIQUE INDEX unique_email ON users USING btree (lower(email));

CREATE TABLE reset_tokens (
  user_id int  NOT NULL  REFERENCES users(id),
  token   uuid NOT NULL,
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  expired_at timestamp with time zone NOT NULL  DEFAULT NOW() + INTERVAL '15 minutes'
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY,
  user_id    int  REFERENCES users(id),
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
  category_id     int NOT NULL  REFERENCES categories(id),
  parent_forum_id int NULL  REFERENCES forums(id),
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
  user_id    int NOT NULL  REFERENCES users(id),
  forum_id   int NOT NULL  REFERENCES forums(id),
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

CREATE INDEX topics_latest_post_id_DESC_idx ON topics (latest_post_id DESC);
CREATE TYPE post_type AS ENUM ('ic', 'ooc', 'char');

CREATE TABLE posts (
  id         serial PRIMARY KEY,
  text       text NOT NULL,
  topic_id   int NOT NULL  REFERENCES topics(id),
  user_id    int NOT NULL  REFERENCES users(id),
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  updated_at timestamp with time zone NULL,
  is_roleplay boolean NOT NULL,
  type       post_type NOT NULL,
  ip_address inet NULL,
  is_hidden  boolean NOT NULL  DEFAULT false
);

CREATE INDEX ON posts (topic_id);
CREATE INDEX ON posts (id, user_id);

-- Last post cache
ALTER TABLE forums ADD COLUMN latest_post_id int NULL REFERENCES posts(id);
ALTER TABLE topics ADD COLUMN latest_post_id int NULL REFERENCES posts(id);
ALTER TABLE topics ADD COLUMN latest_ic_post_id int NULL REFERENCES posts(id);
ALTER TABLE topics ADD COLUMN latest_ooc_post_id int NULL REFERENCES posts(id);
ALTER TABLE topics ADD COLUMN latest_char_post_id int NULL REFERENCES posts(id);

CREATE TABLE topic_subscriptions (
  user_id int NOT NULL  REFERENCES users(id),
  topic_id int NOT NULL  REFERENCES topics(id),
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
  pms_count int    NOT NULL  DEFAULT 0
);

CREATE TABLE pms (
  id         serial PRIMARY KEY,
  text       text   NOT NULL,
  convo_id   int    NOT NULL  REFERENCES convos(id) ON DELETE CASCADE,
  user_id    int    NOT NULL  REFERENCES users(id),
  ip_address inet   NULL,
  created_at timestamp with time zone NOT NULL  DEFAULT NOW(),
  updated_at timestamp with time zone NULL
);

CREATE TABLE convos_participants (
  convo_id int NOT NULL  REFERENCES convos(id) ON DELETE CASCADE,
  user_id  int NOT NULL  REFERENCES users(id) ON DELETE CASCADE
);
-- TODO: Uniq on user_id, convo_id
