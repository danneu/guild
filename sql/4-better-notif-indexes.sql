-- Ensure that a user can only have one notification for each type at a time

-- One MENTION per post (we don't create mentions for PMs)
create unique index notifications_mention_unique on notifications (to_user_id, post_id) 
  where type = 'MENTION';
-- and post_id is not null; (post_id is always set if we create a mention)

-- One QUOTE per post
create unique index notifications_quote_unique on notifications (to_user_id, post_id) 
  where type = 'QUOTE';
-- and post_id is not null; (post_id is always set if we create a quote)

-- One TOPIC_SUB per topic
create unique index notifications_topic_sub_unique on notifications (to_user_id, topic_id) 
  where type = 'TOPIC_SUB';
-- and topic_id is not null; (topic_id is always set if we create a topic sub)

-- One CONVO per convo
create unique index notifications_convo_unique on notifications (to_user_id, convo_id) 
  where type = 'CONVO';
-- and convo_id is not null; (convo_id is always set if we create a convo)

-- One RATING per post (PMs can't have ratings)
-- We'd have to change this if we allow ratings on PMs which is a reasonable possibility
create unique index notifications_rating_unique on notifications (to_user_id, post_id) 
  where type = 'RATING';
-- and post_id is not null; (post_id is always set if we create a rating)

-- One TOPLEVEL_VM per user (this is created when a user creates a new VM on their page)
-- I don't think we create notifications when a user replies to a VM on their page that wasn't
-- created by them.
DROP INDEX IF EXISTS notifications_toplevel_vm_unique;

CREATE UNIQUE INDEX notifications_toplevel_vm_unique ON notifications (to_user_id, vm_id) WHERE type = 'TOPLEVEL_VM';

-- One REPLY_VM per user per VM (everyone someone replies to their VM, the count++)
DROP INDEX IF EXISTS notifications_reply_vm_unique;

CREATE UNIQUE INDEX notifications_reply_vm_unique ON notifications (to_user_id, vm_id) WHERE type = 'REPLY_VM';

--------------------------------
-- Delete obsolete indexes
--------------------------------

-- Remove UNIQUE (to_user_id, convo_id) constraint
-- obsoleted by new index notifications_convo_unique
ALTER TABLE notifications
DROP CONSTRAINT notifications_to_user_id_convo_id_key;

-- TODO: Must remove its use from ON CONFLICT clause in db.createVmNotification
DROP INDEX unique_to_user_id_vm_id;