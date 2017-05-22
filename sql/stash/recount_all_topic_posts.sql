UPDATE topics
SET 
  posts_count = sub.posts_count,
  ic_posts_count = sub.ic_posts_count,
  ooc_posts_count = sub.ooc_posts_count,
  char_posts_count = sub.char_posts_count
FROM (
  SELECT 
    id,
    (SELECT COUNT(*) FROM posts WHERE topic_id = t.id) posts_count,
    (SELECT COUNT(*) FROM posts WHERE topic_id = t.id AND type = 'ic') ic_posts_count, 
    (SELECT COUNT(*) FROM posts WHERE topic_id = t.id AND type = 'ooc') ooc_posts_count, 
    (SELECT COUNT(*) FROM posts WHERE topic_id = t.id AND type = 'char') char_posts_count
  FROM topics t
) sub
WHERE topics.id = sub.id
