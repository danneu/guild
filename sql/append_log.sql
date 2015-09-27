
------------------------------------------------------------
-- Put schema changes here as an append-only log that update
-- SQL seen in schema.sql and functions_and_triggers.sql
------------------------------------------------------------

--
-- Prune out old/unused queries
--

-- Failed indexes for the deimplemented "Topic X was moved to Forum Y"
-- papertrail system
DROP INDEX IF EXISTS topics_moved_at_latest_post_at;
DROP INDEX IF EXISTS topics_sort_1;

-- For show-forum topics ordering
CREATE INDEX topics_order_crystal ON topics (is_sticky DESC, latest_post_at DESC);
