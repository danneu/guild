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
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE role_type AS ENUM ('admin', 'smod', 'mod', 'member', 'banned');

CREATE TABLE users (
  id             serial PRIMARY KEY,
  uname          text NOT NULL,  -- Unique index added later in schema
  digest         text NOT NULL,
  email          text NOT NULL,  -- Unique index added later in schema
  oldguild_uname text NULL,
  created_at     timestamp with time zone NOT NULL  DEFAULT NOW(),
  role           role_type NOT NULL  DEFAULT 'member'
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

------------------------------------------------------------

-- Update forum.topics_count when a topic is inserted/deleted

-- http://www.postgresql.org/docs/9.1/static/sql-start-transaction.html
-- http://www.postgresql.org/docs/8.0/static/plpgsql-trigger.html
-- http://www.postgresql.org/docs/9.1/static/sql-createtrigger.html
CREATE OR REPLACE FUNCTION update_forum_topics_count()
RETURNS trigger AS $update_forum_topics_count$
    BEGIN
        IF (TG_OP = 'DELETE') THEN
            UPDATE forums
            SET topics_count = topics_count - 1
            WHERE id = OLD.forum_id;
        ELSIF (TG_OP = 'INSERT') THEN
            UPDATE forums
            SET topics_count = topics_count + 1
            WHERE id = NEW.forum_id;
        END IF;
        RETURN NULL; -- result is ignored since this is an AFTER trigger
    END;
$update_forum_topics_count$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS topic_created ON topics;
CREATE TRIGGER topic_created
    AFTER INSERT OR DELETE ON topics
    FOR EACH ROW
    EXECUTE PROCEDURE update_forum_topics_count();

------------------------------------------------------------
-- Update forum.posts_count when a post is inserted/deleted

CREATE OR REPLACE FUNCTION update_forum_posts_count()
RETURNS trigger AS $update_forum_posts_count$
    BEGIN
        IF (TG_OP = 'DELETE') THEN
            UPDATE forums
            SET posts_count = posts_count - 1
            WHERE id = (
              SELECT forum_id
              FROM topics
              WHERE topics.id = OLD.topic_id
            );
        ELSIF (TG_OP = 'INSERT') THEN
            UPDATE forums
            SET posts_count = posts_count + 1
            WHERE id = (
              SELECT forum_id
              FROM topics
              WHERE topics.id = NEW.topic_id
            );
        END IF;
        RETURN NULL; -- result is ignored since this is an AFTER trigger
    END;
$update_forum_posts_count$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS post_created1 ON posts;
CREATE TRIGGER post_created1
    AFTER INSERT OR DELETE ON posts
    FOR EACH ROW
    EXECUTE PROCEDURE update_forum_posts_count();

------------------------------------------------------------
-- Update the counter caches for a topic when a post is added/removed
CREATE OR REPLACE FUNCTION update_topic_post_counts() RETURNS trigger AS
$$
  var totalDelta = 0;
  var icDelta = 0;
  var oocDelta = 0;
  var charDelta = 0;
  var topicId;
  var q;
  if (TG_OP === 'DELETE') {
    totalDelta--;
    topicId = OLD.topic_id;
  }
  if (TG_OP === 'INSERT') {
    totalDelta++;
    topicId = NEW.topic_id;
  }
  if (TG_OP === 'DELETE' && OLD.type === 'ic') icDelta--;
  if (TG_OP === 'INSERT' && NEW.type === 'ic') icDelta++;
  if (TG_OP === 'DELETE' && OLD.type === 'ooc') oocDelta--;
  if (TG_OP === 'INSERT' && NEW.type === 'ooc') oocDelta++;
  if (TG_OP === 'DELETE' && OLD.type === 'char') charDelta--;
  if (TG_OP === 'INSERT' && NEW.type === 'char') charDelta++;
  q = 'UPDATE topics SET posts_count = posts_count + $1, ic_posts_count = ic_posts_count + $2, ooc_posts_count = ooc_posts_count + $3, char_posts_count = char_posts_count + $4 WHERE id = $5';
  plv8.execute(q, [totalDelta, icDelta, oocDelta, charDelta, topicId]);
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS post_inserted_or_deleted ON posts;
CREATE TRIGGER post_inserted_or_deleted
    AFTER INSERT OR DELETE ON posts
    FOR EACH ROW
    EXECUTE PROCEDURE update_topic_post_counts();

------------------------------------------------------------
-- Update the containing forum's and topic's latest_post_id whenever a post
-- is created

CREATE OR REPLACE FUNCTION update_latest_post_id() RETURNS trigger AS
$$
  var q = 'UPDATE forums           '+
          'SET latest_post_id = $1 '+
          'WHERE id = (            '+
          '  SELECT forum_id       '+
          '  FROM topics           '+
          '  WHERE topics.id = $2  '+
          ')                       ';

  plv8.execute(q, [NEW.id, NEW.topic_id]);

  q = 'UPDATE topics                                               '+
      'SET latest_post_id      = $2,                               '+
      '    latest_ic_post_id   = COALESCE($3, latest_ic_post_id),  '+
      '    latest_ooc_post_id  = COALESCE($4, latest_ooc_post_id), '+
      '    latest_char_post_id = COALESCE($5, latest_char_post_id) '+
      'WHERE id = $1                                               ';

  // If NonRP, just set the latest_post_id
  if (!NEW.is_roleplay) {
    plv8.execute(q, [NEW.topic_id, NEW.id, null, null, null]);
    return;
  }

  // Since it is a roleplay, update the appropriate cache
  switch(NEW.type) {
    case 'ic':
      plv8.execute(q, [NEW.topic_id, NEW.id, NEW.id, null,   null]);
      return;
    case 'ooc':
      plv8.execute(q, [NEW.topic_id, NEW.id, null,   NEW.id, null]);
      return;
    case 'char':
      plv8.execute(q, [NEW.topic_id, NEW.id, null,   null,   NEW.id]);
      return;
  }
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS post_created5 ON posts;
CREATE TRIGGER post_created5
    AFTER INSERT ON posts  -- Only on insert
    FOR EACH ROW
    EXECUTE PROCEDURE update_latest_post_id();

------------------------------------------------------------
-- Update convo.pms_count when a pm is inserted/deleted

CREATE OR REPLACE FUNCTION update_convo_pms_count()
RETURNS trigger AS $update_convo_pms_count$
    BEGIN
        IF (TG_OP = 'DELETE') THEN
            UPDATE convos
            SET pms_count = pms_count - 1
            WHERE id = OLD.convo_id;
        ELSIF (TG_OP = 'INSERT') THEN
            UPDATE convos
            SET pms_count = pms_count + 1
            WHERE id = NEW.convo_id;
        END IF;
        RETURN NULL; -- result is ignored since this is an AFTER trigger
    END;
$update_convo_pms_count$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pm_created1 ON pms;
CREATE TRIGGER pm_created1
    AFTER INSERT OR DELETE ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE update_convo_pms_count();
