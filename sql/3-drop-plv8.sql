-- Safe Migration from PLV8 to PostgreSQL SQL
-- This migration explicitly drops triggers before functions to ensure safety
-- Each function maintains 1:1 behavior with the original PLV8 implementation
-- All variables are prefixed with underscore to avoid column name collisions

-- Drop dead plv8 trigger/fn
DROP TRIGGER IF EXISTS arena_outcomes_trigger ON arena_outcomes;
DROP FUNCTION IF EXISTS update_user_arena_stats();


------------------------------------------------------------

-- 1. UPDATE USER POSTS COUNT
------------------------------------------------------------
-- Drop triggers first
DROP TRIGGER IF EXISTS update_user_posts_count_insert_trigger ON posts;
DROP TRIGGER IF EXISTS update_user_posts_count_delete_trigger ON posts;
-- Then drop function
DROP FUNCTION IF EXISTS update_user_posts_count();

CREATE OR REPLACE FUNCTION update_user_posts_count() RETURNS trigger AS $$
DECLARE
    _delta INTEGER := 0;
    _userId INTEGER;
BEGIN
    -- Match PLV8 logic: var userId = (OLD && OLD.user_id) || (NEW && NEW.user_id);
    IF TG_OP = 'DELETE' THEN
        _userId := OLD.user_id;
        _delta := -1;
    ELSIF TG_OP = 'INSERT' THEN
        _userId := NEW.user_id;
        _delta := 1;
    END IF;
    
    -- Exact query from PLV8: q = 'UPDATE users SET posts_count = posts_count + $2 WHERE id = $1';
    UPDATE users 
    SET posts_count = posts_count + _delta 
    WHERE id = _userId;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate triggers exactly as they were
CREATE TRIGGER update_user_posts_count_insert_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    -- Ignore 0th posts
    WHEN (NEW.idx > -1)
    EXECUTE PROCEDURE update_user_posts_count();

CREATE TRIGGER update_user_posts_count_delete_trigger
    AFTER DELETE ON posts
    FOR EACH ROW
    -- Ignore 0th posts
    WHEN (OLD.idx > -1)
    EXECUTE PROCEDURE update_user_posts_count();

------------------------------------------------------------
-- 2. UPDATE USER NOTIFICATIONS COUNT
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS update_user_notifications_count_trigger ON notifications;
-- Then drop function
DROP FUNCTION IF EXISTS update_user_notifications_count();

CREATE OR REPLACE FUNCTION update_user_notifications_count() RETURNS trigger AS $$
DECLARE
    _delta INTEGER := 0;
    _convoDelta INTEGER := 0;
    _mentionDelta INTEGER := 0;
    _quoteDelta INTEGER := 0;
    _replyVmDelta INTEGER := 0;
    _toplevelVmDelta INTEGER := 0;
    _subDelta INTEGER := 0;
    _notification RECORD;
    _toUserId INTEGER;
BEGIN
    -- Match PLV8: var notification = OLD || NEW;
    IF TG_OP = 'DELETE' THEN
        _notification := OLD;
    ELSE
        _notification := NEW;
    END IF;
    
    _toUserId := _notification.to_user_id;
    
    -- Match PLV8 increment/decrement logic exactly
    IF TG_OP = 'INSERT' THEN
        _delta := 1;
        IF _notification.type = 'CONVO' THEN _convoDelta := 1; END IF;
        IF _notification.type = 'MENTION' THEN _mentionDelta := 1; END IF;
        IF _notification.type = 'QUOTE' THEN _quoteDelta := 1; END IF;
        IF _notification.type = 'REPLY_VM' THEN _replyVmDelta := 1; END IF;
        IF _notification.type = 'TOPLEVEL_VM' THEN _toplevelVmDelta := 1; END IF;
        IF _notification.type = 'TOPIC_SUB' THEN _subDelta := 1; END IF;
    END IF;
    
    IF TG_OP = 'DELETE' THEN
        _delta := -1;
        IF _notification.type = 'CONVO' THEN _convoDelta := -1; END IF;
        IF _notification.type = 'MENTION' THEN _mentionDelta := -1; END IF;
        IF _notification.type = 'QUOTE' THEN _quoteDelta := -1; END IF;
        IF _notification.type = 'REPLY_VM' THEN _replyVmDelta := -1; END IF;
        IF _notification.type = 'TOPLEVEL_VM' THEN _toplevelVmDelta := -1; END IF;
        IF _notification.type = 'TOPIC_SUB' THEN _subDelta := -1; END IF;
    END IF;
    
    -- Execute exact same query as PLV8
    UPDATE users
    SET notifications_count = notifications_count + _delta,
        convo_notifications_count = convo_notifications_count + _convoDelta,
        mention_notifications_count = mention_notifications_count + _mentionDelta,
        quote_notifications_count = quote_notifications_count + _quoteDelta,
        reply_vm_notifications_count = reply_vm_notifications_count + _replyVmDelta,
        toplevel_vm_notifications_count = toplevel_vm_notifications_count + _toplevelVmDelta,
        sub_notifications_count = sub_notifications_count + _subDelta
    WHERE id = _toUserId;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER update_user_notifications_count_trigger
    AFTER INSERT OR DELETE ON notifications
    FOR EACH ROW
    EXECUTE PROCEDURE update_user_notifications_count();

------------------------------------------------------------
-- 3. UPDATE USER PMS COUNT
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS update_user_pms_count_trigger ON pms;
-- Then drop function
DROP FUNCTION IF EXISTS update_user_pms_count();

CREATE OR REPLACE FUNCTION update_user_pms_count() RETURNS trigger AS $$
DECLARE
    _delta INTEGER := 0;
    _convoId INTEGER;
BEGIN
    -- Initialize delta first (matching PLV8 order)
    _delta := 0;
    
    IF TG_OP = 'INSERT' THEN 
        _delta := 1;
    END IF;
    IF TG_OP = 'DELETE' THEN 
        _delta := -1;
    END IF;
    
    -- Match PLV8: convoId = (OLD && OLD.convo_id) || (NEW && NEW.convo_id);
    IF TG_OP = 'DELETE' THEN
        _convoId := OLD.convo_id;
    ELSE
        _convoId := NEW.convo_id;
    END IF;
    
    -- Execute exact same query as PLV8
    UPDATE users
    SET pms_count = pms_count + _delta
    WHERE id IN (
        SELECT cp.user_id
        FROM convos c
        JOIN convos_participants cp ON c.id = cp.convo_id
        WHERE c.id = _convoId
    );
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER update_user_pms_count_trigger
    AFTER INSERT OR DELETE ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE update_user_pms_count();

------------------------------------------------------------
-- 4. UPDATE TOPIC POST COUNTS
------------------------------------------------------------
-- Drop triggers first
DROP TRIGGER IF EXISTS post_inserted ON posts;
DROP TRIGGER IF EXISTS post_deleted ON posts;
-- Then drop function
DROP FUNCTION IF EXISTS update_topic_post_counts();

CREATE OR REPLACE FUNCTION update_topic_post_counts() RETURNS trigger AS $$
DECLARE
    _totalDelta INTEGER := 0;
    _icDelta INTEGER := 0;
    _oocDelta INTEGER := 0;
    _charDelta INTEGER := 0;
    _topicId INTEGER;
BEGIN
    -- Initialize all deltas to 0 (matching PLV8)
    _totalDelta := 0;
    _icDelta := 0;
    _oocDelta := 0;
    _charDelta := 0;
    
    -- Handle DELETE operations
    IF TG_OP = 'DELETE' THEN
        _totalDelta := -1;
        _topicId := OLD.topic_id;
    END IF;
    
    -- Handle INSERT operations
    IF TG_OP = 'INSERT' THEN
        _totalDelta := 1;
        _topicId := NEW.topic_id;
    END IF;
    
    -- Handle type-specific deltas for DELETE
    IF TG_OP = 'DELETE' AND OLD.type = 'ic' THEN _icDelta := -1; END IF;
    IF TG_OP = 'DELETE' AND OLD.type = 'ooc' THEN _oocDelta := -1; END IF;
    IF TG_OP = 'DELETE' AND OLD.type = 'char' THEN _charDelta := -1; END IF;
    
    -- Handle type-specific deltas for INSERT
    IF TG_OP = 'INSERT' AND NEW.type = 'ic' THEN _icDelta := 1; END IF;
    IF TG_OP = 'INSERT' AND NEW.type = 'ooc' THEN _oocDelta := 1; END IF;
    IF TG_OP = 'INSERT' AND NEW.type = 'char' THEN _charDelta := 1; END IF;
    
    -- Execute exact same query as PLV8
    UPDATE topics 
    SET posts_count = posts_count + _totalDelta,
        ic_posts_count = ic_posts_count + _icDelta,
        ooc_posts_count = ooc_posts_count + _oocDelta,
        char_posts_count = char_posts_count + _charDelta
    WHERE id = _topicId;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate triggers
CREATE TRIGGER post_inserted
    AFTER INSERT ON posts
    FOR EACH ROW
    -- Ignore 0th posts
    WHEN (NEW.idx > -1)
    EXECUTE PROCEDURE update_topic_post_counts();

CREATE TRIGGER post_deleted
    AFTER DELETE ON posts
    FOR EACH ROW
    -- Ignore 0th posts
    WHEN (OLD.idx > -1)
    EXECUTE PROCEDURE update_topic_post_counts();

------------------------------------------------------------
-- 5. ON POST HIDDEN
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS post_hidden ON posts;
-- Then drop function
DROP FUNCTION IF EXISTS on_post_hidden();

CREATE OR REPLACE FUNCTION on_post_hidden() RETURNS trigger AS $$
DECLARE
    _forum_id INTEGER;
BEGIN
    -- First query - update topics and get forum_id
    WITH latest_post AS (
        SELECT id, created_at FROM posts
        WHERE idx > -1 AND is_hidden = false AND topic_id = NEW.topic_id
        ORDER BY id DESC LIMIT 1
    )
    UPDATE topics
    SET latest_post_at = (SELECT created_at FROM latest_post),
        latest_post_id = (SELECT id FROM latest_post),
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
    
    -- Second query - update forums using the forum_id we just got
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

-- Recreate trigger
CREATE TRIGGER post_hidden
    AFTER UPDATE ON posts
    FOR EACH ROW
    -- Only execute when is_hidden is changed
    -- Ignore 0th posts
    WHEN (OLD.is_hidden != NEW.is_hidden AND NEW.idx > -1)
    EXECUTE PROCEDURE on_post_hidden();

------------------------------------------------------------
-- 6. UPDATE LATEST POST ID
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS post_created5 ON posts;
-- Then drop function
DROP FUNCTION IF EXISTS update_latest_post_id();

CREATE OR REPLACE FUNCTION update_latest_post_id() RETURNS trigger AS $$
BEGIN
    -- First query - update forums
    UPDATE forums
    SET latest_post_id = NEW.id
    WHERE id = (
        SELECT forum_id
        FROM topics
        WHERE topics.id = NEW.topic_id
    );
    
    -- Second query - update topics based on post type
    -- Using same switch/case logic as PLV8
    CASE NEW.type
        WHEN 'ic' THEN
            UPDATE topics
            SET latest_post_id = NEW.id,
                latest_ic_post_id = NEW.id,
                latest_ooc_post_id = latest_ooc_post_id,
                latest_char_post_id = latest_char_post_id,
                latest_post_at = NOW()
            WHERE id = NEW.topic_id;
            
        WHEN 'ooc' THEN
            UPDATE topics
            SET latest_post_id = NEW.id,
                latest_ic_post_id = latest_ic_post_id,
                latest_ooc_post_id = NEW.id,
                latest_char_post_id = latest_char_post_id,
                latest_post_at = NOW()
            WHERE id = NEW.topic_id;
            
        WHEN 'char' THEN
            UPDATE topics
            SET latest_post_id = NEW.id,
                latest_ic_post_id = latest_ic_post_id,
                latest_ooc_post_id = latest_ooc_post_id,
                latest_char_post_id = NEW.id,
                latest_post_at = NOW()
            WHERE id = NEW.topic_id;
    END CASE;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER post_created5
    AFTER INSERT ON posts
    FOR EACH ROW
    -- Ignore 0th posts
    WHEN (NEW.idx > -1)
    EXECUTE PROCEDURE update_latest_post_id();

------------------------------------------------------------
-- 7. INSERT TROPHIES USERS
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS insert_trophies_users_trigger ON trophies_users;
-- Then drop function
DROP FUNCTION IF EXISTS insert_trophies_users();

CREATE OR REPLACE FUNCTION insert_trophies_users() RETURNS trigger AS $$
DECLARE
    _prev_awarded_count BIGINT;
BEGIN
    -- Count how many times this trophy has been awarded (BEFORE insert)
    -- Using COUNT(tu) to match PLV8 exactly
    SELECT COUNT(tu) INTO _prev_awarded_count
    FROM trophies_users tu
    WHERE tu.trophy_id = NEW.trophy_id;
    
    -- Update this awarding's trophy's awarded_count
    UPDATE trophies
    SET awarded_count = 1 + _prev_awarded_count
    WHERE id = NEW.trophy_id;
    
    -- Update user.trophy_count
    UPDATE users
    SET trophy_count = (
        SELECT COUNT(tu) + 1
        FROM trophies_users tu
        WHERE tu.user_id = NEW.user_id
    )
    WHERE id = NEW.user_id;
    
    -- Update this awarding's n
    NEW.n = 1 + _prev_awarded_count;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER insert_trophies_users_trigger
    BEFORE INSERT ON trophies_users
    FOR EACH ROW
    EXECUTE PROCEDURE insert_trophies_users();

------------------------------------------------------------
-- 8. DELETE TROPHIES USERS
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS delete_trophies_users_trigger ON trophies_users;
-- Then drop function
DROP FUNCTION IF EXISTS delete_trophies_users();

CREATE OR REPLACE FUNCTION delete_trophies_users() RETURNS trigger AS $$
DECLARE
    _awarded_count BIGINT;
BEGIN
    -- Count how many times this trophy has been awarded (AFTER delete)
    -- Using COUNT(tu) to match PLV8 exactly
    SELECT COUNT(tu) INTO _awarded_count
    FROM trophies_users tu
    WHERE tu.trophy_id = OLD.trophy_id;
    
    -- Update user.trophy_count (runs AFTER delete)
    UPDATE users
    SET trophy_count = (
        SELECT COUNT(tu)
        FROM trophies_users tu
        WHERE tu.user_id = OLD.user_id
    )
    WHERE id = OLD.user_id;
    
    -- Update this awarding's trophy's awarded_count
    UPDATE trophies
    SET awarded_count = _awarded_count
    WHERE id = OLD.trophy_id;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER delete_trophies_users_trigger
    AFTER DELETE ON trophies_users
    FOR EACH ROW
    EXECUTE PROCEDURE delete_trophies_users();

------------------------------------------------------------
-- 9. AFTER INSERT STATUSES
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS after_insert_statuses_trigger ON statuses;
-- Then drop function
DROP FUNCTION IF EXISTS after_insert_statuses();

CREATE OR REPLACE FUNCTION after_insert_statuses() RETURNS trigger AS $$
BEGIN
    UPDATE users
    SET current_status_id = NEW.id
    WHERE id = NEW.user_id;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER after_insert_statuses_trigger
    AFTER INSERT ON statuses
    FOR EACH ROW
    EXECUTE PROCEDURE after_insert_statuses();

------------------------------------------------------------
-- 10. UPDATE CONVO PMS COUNT (non-PLV8 function, keeping for completeness)
------------------------------------------------------------
-- Already in pure SQL, but including for safety
DROP TRIGGER IF EXISTS pm_created1 ON pms;
-- Function already exists in plpgsql, no need to drop/recreate

-- Recreate trigger
CREATE TRIGGER pm_created1
    AFTER INSERT OR DELETE ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE update_convo_pms_count();

------------------------------------------------------------
-- 11. UPDATE CONVO LATEST PM (non-PLV8 function, keeping for completeness)
------------------------------------------------------------
-- Already in pure SQL, but including for safety
DROP TRIGGER IF EXISTS update_convo_latest_pm_trigger ON pms;
-- Function already exists in plpgsql, no need to drop/recreate

-- Recreate trigger
CREATE TRIGGER update_convo_latest_pm_trigger
    AFTER INSERT ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE update_convo_latest_pm();

------------------------------------------------------------
-- 12. SET VM IDX
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS trigger_set_vm_idx ON vms;
-- Then drop function
DROP FUNCTION IF EXISTS set_vm_idx();

CREATE OR REPLACE FUNCTION set_vm_idx() RETURNS trigger AS $$
DECLARE
    _idx INTEGER;
BEGIN
    -- Only set idx for top-level vms (no parent_vm_id)
    -- Match PLV8: if (NEW.parent_vm_id) return NEW;
    IF NEW.parent_vm_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    
    -- Get the next idx for this user's VMs
    SELECT COALESCE(MAX(vms.idx) + 1, 0) INTO _idx
    FROM vms
    WHERE vms.to_user_id = NEW.to_user_id;
    
    NEW.idx = _idx;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER trigger_set_vm_idx
    BEFORE INSERT ON vms
    FOR EACH ROW
    EXECUTE PROCEDURE set_vm_idx();

------------------------------------------------------------
-- 13. UPDATE PARENT VM
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS update_parent_vm_trigger ON vms;
-- Then drop function
DROP FUNCTION IF EXISTS update_parent_vm();

CREATE OR REPLACE FUNCTION update_parent_vm() RETURNS trigger AS $$
DECLARE
    _thisVm RECORD;
    _delta INTEGER := 0;
BEGIN
    -- Match PLV8: var thisVm = (OLD || NEW);
    IF TG_OP = 'DELETE' THEN
        _thisVm := OLD;
    ELSE
        _thisVm := NEW;
    END IF;
    
    -- Short-circuit if there is no parent VM
    IF _thisVm.parent_vm_id IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Calculate delta
    IF TG_OP = 'INSERT' THEN
        _delta := 1;
    ELSIF TG_OP = 'DELETE' THEN
        _delta := -1;
    END IF;
    
    -- Update parent VM's count
    UPDATE vms 
    SET vms_count = vms_count + _delta 
    WHERE id = _thisVm.parent_vm_id;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER update_parent_vm_trigger
    AFTER INSERT OR DELETE ON vms
    FOR EACH ROW
    EXECUTE PROCEDURE update_parent_vm();

------------------------------------------------------------
-- 14. UPDATE USER VMS COUNT
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS update_user_vms_count_trigger ON vms;
-- Then drop function
DROP FUNCTION IF EXISTS update_user_vms_count();

CREATE OR REPLACE FUNCTION update_user_vms_count() RETURNS trigger AS $$
DECLARE
    _totalDelta INTEGER := 0;
    _toplevelDelta INTEGER := 0;
    _thisVm RECORD;
    _toUserId INTEGER;
BEGIN
    -- Match PLV8: var thisVm = (OLD || NEW);
    IF TG_OP = 'DELETE' THEN
        _thisVm := OLD;
    ELSE
        _thisVm := NEW;
    END IF;
    
    _toUserId := _thisVm.to_user_id;
    
    -- Calculate deltas
    IF TG_OP = 'INSERT' THEN
        _totalDelta := 1;
        IF _thisVm.parent_vm_id IS NULL THEN
            _toplevelDelta := 1;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        _totalDelta := -1;
        IF _thisVm.parent_vm_id IS NULL THEN
            _toplevelDelta := -1;
        END IF;
    END IF;
    
    -- Update user counts
    UPDATE users
    SET total_vms_count = total_vms_count + _totalDelta,
        toplevel_vms_count = toplevel_vms_count + _toplevelDelta
    WHERE id = _toUserId;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER update_user_vms_count_trigger
    AFTER INSERT OR DELETE ON vms
    FOR EACH ROW
    EXECUTE PROCEDURE update_user_vms_count();


------------------------------------------------------------
-- 15. UPDATE POST REV COUNT
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS update_post_rev_count_trigger ON post_revs;
-- Then drop function
DROP FUNCTION IF EXISTS update_post_rev_count();

CREATE OR REPLACE FUNCTION update_post_rev_count() RETURNS trigger AS $$
DECLARE
    _delta INTEGER := 0;
    _postId INTEGER;
BEGIN
    -- Match PLV8: var postId = (OLD && OLD.post_id) || (NEW && NEW.post_id)
    IF TG_OP = 'DELETE' THEN
        _postId := OLD.post_id;
        _delta := -1;
    ELSIF TG_OP = 'INSERT' THEN
        _postId := NEW.post_id;
        _delta := 1;
    END IF;
    
    -- Update post revision count
    UPDATE posts 
    SET rev_count = rev_count + _delta 
    WHERE id = _postId;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER update_post_rev_count_trigger
    AFTER INSERT OR DELETE ON post_revs
    FOR EACH ROW
    EXECUTE PROCEDURE update_post_rev_count();

------------------------------------------------------------
-- 16. SET PM IDX
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS trigger_set_pm_idx ON pms;
-- Then drop function
DROP FUNCTION IF EXISTS set_pm_idx();

CREATE OR REPLACE FUNCTION set_pm_idx() RETURNS trigger AS $$
DECLARE
    _idx INTEGER;
BEGIN
    -- Get the next idx for this conversation's PMs
    SELECT COALESCE(MAX(pms.idx) + 1, 0) INTO _idx
    FROM pms
    WHERE pms.convo_id = NEW.convo_id;
    
    NEW.idx = _idx;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER trigger_set_pm_idx
    BEFORE INSERT ON pms
    FOR EACH ROW
    EXECUTE PROCEDURE set_pm_idx();

------------------------------------------------------------
-- 17. SET POST IDX
------------------------------------------------------------
-- Drop trigger first
DROP TRIGGER IF EXISTS trigger_set_post_idx ON posts;
-- Then drop function
DROP FUNCTION IF EXISTS set_post_idx();

CREATE OR REPLACE FUNCTION set_post_idx() RETURNS trigger AS $$
DECLARE
    _idx INTEGER;
BEGIN
    -- Match PLV8: if (NEW.idx === -1) { return NEW }
    IF NEW.idx = -1 THEN
        RETURN NEW;
    END IF;
    
    -- Get the next idx for this topic and post type
    SELECT COALESCE(MAX(p.idx) + 1, 0) INTO _idx
    FROM posts p
    WHERE p.topic_id = NEW.topic_id AND p.type = NEW.type;
    
    NEW.idx = _idx;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate trigger
CREATE TRIGGER trigger_set_post_idx
    BEFORE INSERT ON posts
    FOR EACH ROW
    EXECUTE PROCEDURE set_post_idx();


------------------------------------------------------------
-- 18. DROP EXTENSION
------------------------------------------------------------

-- THIS IS THE MOMENT WE'VE BEEN WAITING FOR

DROP EXTENSION IF EXISTS plv8 CASCADE;