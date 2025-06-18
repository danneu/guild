-- When we hide a post, we want to update the topic's latest post to the latest
-- non-hidden post. But if there are no non-hidden posts, then we use the latest
-- hidden post so that the hidden topic will still sort.

-- IC/OOC/CHAR latest post logic is unchanged: they only consider non-hidden posts.

CREATE OR REPLACE FUNCTION on_post_hidden() RETURNS trigger AS $$
DECLARE
    _forum_id INTEGER;
    _latest_post RECORD;
BEGIN
    -- For overall latest post: try non-hidden first, then fall back to hidden
    SELECT id, created_at INTO _latest_post
    FROM posts
    WHERE idx > -1 AND is_hidden = false AND topic_id = NEW.topic_id
    ORDER BY id DESC LIMIT 1;
    
    -- If no non-hidden posts, get the latest hidden one
    IF _latest_post.id IS NULL THEN
        SELECT id, created_at INTO _latest_post
        FROM posts
        WHERE idx > -1 AND topic_id = NEW.topic_id
        ORDER BY id DESC LIMIT 1;
    END IF;
    
    -- Update topics
    -- Type-specific posts only look at non-hidden posts (can be NULL)
    UPDATE topics
    SET latest_post_at = _latest_post.created_at,
        latest_post_id = _latest_post.id,
        latest_ic_post_id = (
            SELECT id FROM posts
            WHERE idx > -1 AND is_hidden = false AND topic_id = NEW.topic_id AND type = 'ic'
            ORDER BY id DESC LIMIT 1
        ),
        latest_ooc_post_id = (
            SELECT id FROM posts
            WHERE idx > -1 AND is_hidden = false AND topic_id = NEW.topic_id AND type = 'ooc'
            ORDER BY id DESC LIMIT 1
        ),
        latest_char_post_id = (
            SELECT id FROM posts
            WHERE idx > -1 AND is_hidden = false AND topic_id = NEW.topic_id AND type = 'char'
            ORDER BY id DESC LIMIT 1
        )
    WHERE id = NEW.topic_id
    RETURNING forum_id INTO _forum_id;
    
    -- Update forums (unchanged)
    UPDATE forums
    SET posts_count = COALESCE(sub.posts_count, 0),
        latest_post_id = sub.latest_post_id
    FROM (
        SELECT
            SUM(posts_count) posts_count,
            MAX(latest_post_id) latest_post_id
        FROM topics
        WHERE forum_id = _forum_id
            AND is_hidden = false
    ) sub
    WHERE id = _forum_id;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;