---- Users
INSERT INTO users (id, uname, email, digest)
VALUES
-- The password for seed users is 'secret'
(1, 'foo', 'foo@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci'),
(2, 'bar', 'bar@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci'),
(3, 'fuz', 'fuz@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci')
;
SELECT setval('users_id_seq'::regclass, (SELECT MAX(id) FROM users));

---- Convos
INSERT INTO convos (id, user_id, title)
VALUES
(1, 1, 'Just foo'),
(2, 1, 'foo -> bar'),
(3, 1, 'foo -> bar, fuz')
;
INSERT INTO convos_participants (convo_id, user_id)
VALUES
(1, 1)
,(2, 1)
,(2, 2)
,(3, 1)
,(3, 2)
,(3, 3)
;
SELECT setval('convos_id_seq'::regclass, (SELECT MAX(id) FROM convos));

--- Pms
INSERT INTO pms (convo_id, user_id, text)
VALUES
(1, 1, 'hey, self')
;
SELECT setval('pms_id_seq'::regclass, (SELECT MAX(id) FROM pms));

---- Categories
INSERT INTO categories (id, title, description, pos)
VALUES
(1, 'News and Newcomers', null, 1),
(2, 'Roleplaying', null, 2),
(3, 'Test Category', null, 3),
(4, 'Off-Topic', null, 4),
(5, 'Meta', null, 5)
;
SELECT setval('categories_id_seq'::regclass, (SELECT MAX(id) FROM categories));

---- Forums
INSERT INTO forums (category_id, parent_forum_id, id, title, description, pos, is_roleplay)
VALUES
-- News and Newcomers (id 1)
(1, null, 1, 'News', 'Official RPGuild News is posted here.', 1, false),
(1, null, 2, 'Introduce Yourself', 'New to RPGuild? Come say hello!', 2, false),
-- Roleplaying (id 2)
(2, null, 38, 'General Interest Checks', 'This forum is for more general interest checks. Perhaps they span multiple roleplaying subforums.', 1, false),
(2, null, 3, 'Free Roleplay', 'No standards. For roleplaying involving one-liners, few-liners, speed-posting, and for anyone who doesn''t want to have to worry about standards. Roleplays that don''t fulfill Casual standards are moved here.', 2, true),
  (2, 3, 12, 'Free Interest Checks', null, 1, false),
(2, null, 4, 'Casual Roleplay', 'Medium standards. Roleplay here if you enjoy writing at least a paragraph or two, character development, and some depth. Casual RP is more laid back and lighthearted than Advanced RP but more moderated than Free RP. It''s a good fit for most roleplayers. Acceptable spelling and grammar required.', 3, true),
  (2, 4, 13, 'Casual Interest Checks', null, 1, false),
(2, null, 5, 'Advanced Roleplay', 'Strict, highly moderated roleplay with elevated standards. Advanced RP focuses on longer posts that include character development and coherent writing ability.', 4, true),
  (2, 5, 14, 'Advanced Interest Checks', null, 1, false),
(2, null, 6, 'Arena Roleplay', 'Battle-centered roleplay.', 5, true),
  (2, 6, 15, 'Arena Interest Checks', null, 1, false),
(2, null, 7, '1x1 Roleplay', 'Two players per roleplay here.', 6, true),
  (2, 7, 16, '1x1 Interest Checks', null, 1, false),
(2, null, 42, 'Nation Roleplay', 'Create and control a nation that collides with other nations through political, economic, and diplomatic warfare.', 7, true),
  (2, 42, 43, 'Nation Interest Checks', null, 1, false),
(2, null, 39, 'Tabletop Roleplay', 'Roleplays focused on dice rolls and stat blocks where the narrative is driven by game mechanics.', 8, true),
  (2, 39, 40, 'Tabletop Interest Checks', null, 1, false),
-- Test Category (id 3)
(3, null, 31, 'Test Forum', 'Test forum features and try to break things here.', 1, false),
(3, null, 30, 'Spam Forum', 'Where people go to make me regret everything.', 2, false),
-- Off-Topic (id 4)
(4, null, 41, 'Roleplaying Discussion', 'Discussion related to roleplaying and GMing.', 1, false),
(4, null, 32, 'Member Lounge', 'Come unwind with the rest of RPG and socialize. Post your blogs, leaving threads, birthday threads, and general interest threads here.', 2, false),
(4, null, 33, 'Off-Topic Discussion', 'No spam.', 3, false),
(4, null, 34, 'Character Sheets', 'Feel free to post your character sheets here to keep track of characters, view other characters, and share your characters with the world.', 4, false),
(4, null, 35, 'The Gallery', 'Come share your own art and literary work! (Includes shops & requests)', 5, false),
(4, null, 37, 'Articles & Guides', 'User-submitted resources for helping you with your roleplay life, your forum life, and your life life.', 6, false),
-- Meta (id 5)
(5, null, 9, 'Feature Requests & Bugs', 'Share and brainstorming ideas for making RPGuild a better community.', 1, false),
(5, null, 36, 'Need Help?', 'Have a question about the site? Need to talk to Guild staff? Until I have a better solution, you can come here to get help. (Note: No more username changes allowed. We don''t rename topics. We don''t delete roleplays once other people have posted in them. There are exceptions, of course.)', 2, false)
;
SELECT setval('forums_id_seq'::regclass, (SELECT MAX(id) FROM forums));

---- Topics
INSERT INTO topics (id, forum_id, title, user_id, is_hidden, is_closed, is_sticky, is_roleplay)
VALUES
 (1, 1, 'Test Topic A',        1, false, true,  false, false)  -- nonrp
,(2, 1, 'Test Topic B',        1, false, false, true,  false)  -- nonrp
,(3, 1, 'Test Topic C',        1, false, false, false, false) -- nonrp
,(4, 3, 'The Flob''s Journey', 1, false, false, false, true)  -- free-rp
;
---- Posts
INSERT INTO posts (id, topic_id, user_id, text, ip_address, type, is_roleplay)
VALUES
(1, 1, 1, 'First post', '1.2.3.4', 'ooc', false)
,(2, 2, 1, 'First post', '1.2.3.4', 'ooc', false)
,(3, 3, 1, 'First post', '1.2.3.4', 'ooc', false)
,(4, 4, 1, 'First IC post', '1.2.3.4', 'ic', true);
SELECT setval('topics_id_seq'::regclass, (SELECT MAX(id) FROM topics));
SELECT setval('posts_id_seq'::regclass, (SELECT MAX(id) FROM posts));

---- Topic subscriptions
INSERT INTO topic_subscriptions (topic_id, user_id)
VALUES
(1, 1)  -- foo + nonrp
,(4, 1)  -- foo + rp (the flob's journey)
;
