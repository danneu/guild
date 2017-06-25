
-- Create the first revision for all posts
INSERT INTO post_revs (post_id, user_id, markup, html, length)
SELECT id, user_id, markup, html, bit_length(markup) / 8
FROM posts
WHERE markup IS NOT NULL
  AND rev_count = 0
;

-- initialize table with existing users
INSERT INTO unames (user_id, uname, slug, created_at)
SELECT id, uname, slug, created_at
FROM users;
