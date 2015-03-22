-- http://www.postgresql.org/docs/9.1/static/sql-start-transaction.html
-- http://www.postgresql.org/docs/8.0/static/plpgsql-trigger.html
-- http://www.postgresql.org/docs/9.1/static/sql-createtrigger.html

-- This file contains indexes, constraints, and triggers that should only
-- be created after the big COPY FROM migration.

CREATE INDEX topics_latest_post_id_DESC_idx ON topics (latest_post_id DESC);
CREATE INDEX topics_forum_id_idx            ON topics (forum_id);
CREATE INDEX posts_topic_id_idx             ON posts (topic_id);
CREATE INDEX posts_id_user_id_idx           ON posts (id, user_id);
CREATE INDEX users_created_at_desc          ON users (created_at DESC);
CREATE UNIQUE INDEX cp_uniq_convoId_userId ON convos_participants (convo_id, user_id);
CREATE INDEX convos_id_latestPmId_DESC ON convos (id, latest_pm_id DESC);
CREATE INDEX ON notifications (to_user_id);

-- Remove this index, it was replaced by topics_sort_1
CREATE INDEX topics_moved_at_latest_post_at ON topics (
  COALESCE(moved_at, latest_post_at) DESC
);

CREATE INDEX topics_sort_1 ON topics (
  is_sticky DESC, COALESCE(moved_at, latest_post_at) DESC
);

-- To fetch a user's most recent rating
CREATE INDEX ON ratings (created_at DESC);
CREATE INDEX ON ratings (from_user_id);
CREATE INDEX ON ratings (to_user_id);
CREATE INDEX ON ratings (post_id);

------------------------------------------------------------
------------------------------------------------------------
-- Update forum.topics_count when a topic is inserted/deleted

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
------------------------------------------------------------
-- Update the counter caches for a user when a post is created/deleted

CREATE OR REPLACE FUNCTION update_user_posts_count() RETURNS trigger AS
$$
  var delta = 0;
  var userId = (OLD && OLD.user_id) || (NEW && NEW.user_id);
  if (TG_OP === 'DELETE') delta--;
  if (TG_OP === 'INSERT') delta++
  q = 'UPDATE users SET posts_count = posts_count + $2 WHERE id = $1';
  plv8.execute(q, [userId, delta]);
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS update_user_posts_count_trigger ON posts;
CREATE TRIGGER update_user_posts_count_trigger
    AFTER INSERT OR DELETE ON posts
    FOR EACH ROW
    EXECUTE PROCEDURE update_user_posts_count();

------------------------------------------------------------
------------------------------------------------------------
-- Update users.notifications_count when user receives/deleted
-- notifications

CREATE OR REPLACE function update_user_notifications_count() RETURNS trigger AS
$$
  var q, delta = 0, convoDelta = 0, mentionDelta = 0, quoteDelta = 0;
  var notification = OLD || NEW;
  var toUserId = notification.to_user_id;
  if (TG_OP === 'INSERT') {
    delta++;
    if (notification.type === 'CONVO') convoDelta++;
    if (notification.type === 'MENTION') mentionDelta++;
    if (notification.type === 'QUOTE') quoteDelta++;
  }
  if (TG_OP === 'DELETE') {
    delta--;
    if (notification.type === 'CONVO') convoDelta--;
    if (notification.type === 'MENTION') mentionDelta--;
    if (notification.type === 'QUOTE') quoteDelta--;
  }
  q = 'UPDATE users                                                          '+
      'SET notifications_count = notifications_count + $2,                   '+
      '    convo_notifications_count = convo_notifications_count + $3,       '+
      '    mention_notifications_count = mention_notifications_count + $4,   '+
      '    quote_notifications_count = quote_notifications_count + $5        '+
      'WHERE id = $1                                                         ';
  plv8.execute(q, [toUserId, delta, convoDelta, mentionDelta, quoteDelta]);
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS update_user_notifications_count_trigger ON notifications;
CREATE TRIGGER update_user_notifications_count_trigger
  AFTER INSERT OR DELETE ON notifications
  FOR EACH ROW
  EXECUTE PROCEDURE update_user_notifications_count();

------------------------------------------------------------
------------------------------------------------------------
-- Update the counter caches for a user when a pm is created/deleted

CREATE OR REPLACE FUNCTION update_user_pms_count() RETURNS trigger AS
$$
  var q, delta = 0, convoId;

  q = 'UPDATE users                                          '+
      'SET pms_count = pms_count + $1                        '+
      'WHERE id IN (                                         '+
      '  SELECT cp.user_id                                   '+
      '  FROM convos c                                       '+
      '  JOIN convos_participants cp ON c.id = cp.convo_id   '+
      '  WHERE c.id = $2                                     '+
      ')                                                     ';

  delta = 0;
  if (TG_OP === 'INSERT') delta++;
  if (TG_OP === 'DELETE') delta--;

  convoId = (OLD && OLD.convo_id) || (NEW && NEW.convo_id);

  plv8.execute(q, [delta, convoId]);
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS update_user_pms_count_trigger ON pms;
CREATE TRIGGER update_user_pms_count_trigger
    AFTER INSERT OR DELETE ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE update_user_pms_count();

------------------------------------------------------------
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

  q = 'UPDATE topics                                                '+
      'SET latest_post_id      = $2,                                '+
      '    latest_ic_post_id   = COALESCE($3, latest_ic_post_id),   '+
      '    latest_ooc_post_id  = COALESCE($4, latest_ooc_post_id),  '+
      '    latest_char_post_id = COALESCE($5, latest_char_post_id), '+
      '    latest_post_at      = NOW()                              '+
      'WHERE id = $1                                                ';

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

------------------------------------------------------------
------------------------------------------------------------
-- Update convo.latest_pm_id when a pm is inserted

CREATE OR REPLACE FUNCTION update_convo_latest_pm()
RETURNS trigger AS $update_convo_latest_pm$
    BEGIN
        UPDATE convos
        SET latest_pm_id = NEW.id
        WHERE id = NEW.convo_id;
        RETURN NULL; -- result is ignored since this is an AFTER trigger
    END;
$update_convo_latest_pm$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_convo_latest_pm_trigger ON pms;
CREATE TRIGGER update_convo_latest_pm_trigger
    AFTER INSERT ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE update_convo_latest_pm();

------------------------------------------------------------
------------------------------------------------------------
-- Executed when a user is awarded a trophy.
-- i.e. When insertion in trophies_users table
--
-- Function: insert_trophies_users
-- Trigger:  insert_trophies_users_trigger

-- When a trophy is awarded,
-- + Set NEW.n = COUNT(times this trophy has been awarded before this + 1)
-- + Update this trophy's award_count
-- + Update user's trophy_count

CREATE OR REPLACE FUNCTION insert_trophies_users() RETURNS trigger AS
$$
  var q, rows;

  //-- Count how many times this trophy has been awarded (BEFORE insert)
  q = 'SELECT COUNT(tu) "count" FROM trophies_users tu WHERE tu.trophy_id = $1';
  rows = plv8.execute(q, [NEW.trophy_id]);
  var prev_awarded_count = rows[0].count;

  //-- Update this awarding's trophy's `awarded_count`
  q = 'UPDATE trophies SET awarded_count = $2 WHERE id = $1';
  plv8.execute(q, [NEW.trophy_id, 1 + prev_awarded_count]);

  // -- Update user.trophy_count
  q = 'UPDATE users                       '+
      'SET trophy_count = (               '+
        'SELECT COUNT(tu) + 1             '+
        'FROM trophies_users tu           '+
        'WHERE tu.user_id = $1            '+
      ')                                  '+
      'WHERE id = $1;                     ';
  plv8.execute(q, [NEW.user_id]);

  //-- Update this awarding's `n`
  NEW.n = 1 + prev_awarded_count;

  return NEW;
$$ LANGUAGE 'plv8';
DROP TRIGGER IF EXISTS insert_trophies_users_trigger ON trophies_users;
CREATE TRIGGER insert_trophies_users_trigger
    BEFORE INSERT ON trophies_users
    FOR EACH ROW
    EXECUTE PROCEDURE insert_trophies_users();

------------------------------------------------------------
------------------------------------------------------------
-- Run after a row from trophies_users is deleted
-- i.e. an awarded trophy is being revoked from a user
-- Maybe it was a mistake, they were found out to be cheating, or something
--
-- It updates `trophies.awarded_count` column cache

CREATE OR REPLACE FUNCTION delete_trophies_users() RETURNS trigger AS
$$
  var q, rows;

  //-- Count how many times this trophy has been awarded
  q = 'SELECT COUNT(tu) "count" FROM trophies_users tu WHERE tu.trophy_id = $1';
  rows = plv8.execute(q, [OLD.trophy_id]);
  var awarded_count = rows[0].count;

  // -- Update user.trophy_count (runs AFTER delete)
  q = 'UPDATE users                       '+
      'SET trophy_count = (               '+
        'SELECT COUNT(tu)                 '+
        'FROM trophies_users tu           '+
        'WHERE tu.user_id = $1            '+
      ')                                  '+
      'WHERE id = $1;                     ';
  plv8.execute(q, [OLD.user_id]);

  //-- Update this awarding's trophy's `awarded_count`
  q = 'UPDATE trophies SET awarded_count = $2 WHERE id = $1';
  plv8.execute(q, [OLD.trophy_id, awarded_count]);
$$ LANGUAGE 'plv8';
DROP TRIGGER IF EXISTS delete_trophies_users_trigger ON trophies_users;
CREATE TRIGGER delete_trophies_users_trigger
    AFTER DELETE ON trophies_users
    FOR EACH ROW
    EXECUTE PROCEDURE delete_trophies_users();

------------------------------------------------------------
------------------------------------------------------------
-- Set new statuses to users.current_status_id

CREATE OR REPLACE FUNCTION after_insert_statuses() RETURNS trigger AS
$$
  var q = 'UPDATE users SET current_status_id = $1 WHERE id = $2';
  plv8.execute(q, [NEW.id, NEW.user_id]);
$$ LANGUAGE 'plv8';
DROP TRIGGER IF EXISTS after_insert_statuses_trigger ON statuses;
CREATE TRIGGER after_insert_statuses_trigger
    AFTER INSERT ON statuses
    FOR EACH ROW
    EXECUTE PROCEDURE after_insert_statuses();
