-- http://www.postgresql.org/docs/9.1/static/sql-start-transaction.html
-- http://www.postgresql.org/docs/8.0/static/plpgsql-trigger.html
-- http://www.postgresql.org/docs/9.1/static/sql-createtrigger.html

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
-- Update the counter caches for a user when a pm is created/deleted

CREATE OR REPLACE FUNCTION update_user_pms_count() RETURNS trigger AS
$$
  var delta = 0;
  var userId = (OLD && OLD.user_id) || (NEW && NEW.user_id);
  if (TG_OP === 'DELETE') delta--;
  if (TG_OP === 'INSERT') delta++
  q = 'UPDATE users SET pms_count = pms_count + $2 WHERE id = $1';
  plv8.execute(q, [userId, delta]);
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
-- Update the post page when inserted

CREATE OR REPLACE FUNCTION set_post_page() RETURNS trigger AS
$$
  q = 'UPDATE posts                                       '+
      'SET page = sub.page                                '+
      'FROM (                                             '+
      '  SELECT COALESCE((                                '+
      '    SELECT (COUNT(id) / 20) + 1 "page"             '+
      '    FROM posts                                     '+
      '    WHERE topic_id = $1 AND id < $2 AND type = $3  '+
      '    GROUP BY topic_id                              '+
      '  ), 1) "page"                                     '+
      ') sub                                              '+
      'WHERE posts.id = $2                                ';
  plv8.execute(q, [NEW.topic_id, NEW.id, NEW.type]);
$$ LANGUAGE 'plv8';

DROP TRIGGER IF EXISTS trigger_set_post_page ON posts;
CREATE TRIGGER trigger_set_post_page
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE PROCEDURE set_post_page();

------------------------------------------------------------
------------------------------------------------------------
