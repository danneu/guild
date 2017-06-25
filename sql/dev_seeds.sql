---- Users
INSERT INTO users (id, uname, slug, email, digest, role)
VALUES
-- The password for seed users is 'secret'
(1, 'foo', 'foo', 'foo@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member'),
(2, 'bar', 'bar', 'bar@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member'),
(3, 'fuz', 'fuz', 'fuz@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member'),
(4, 'admin', 'admin', 'admin@example.com',  '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'admin'),
(5, 'mod', 'mod', 'mod@example.com',  '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'mod'),
(6, 'smod', 'smod', 'smod@example.com',  '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'smod'),
(7, 'banned', 'banned', 'banned@example.com',  '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'banned')
,(8,  'arenamod', 'arenamod',   'user8@example.com',  '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'arenamod')
,(9,  'user9', 'user9',   'user9@example.com',  '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member')
,(10, 'user10', 'user10', 'user10@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member')
,(11, 'user11', 'user11', 'user11@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member')
,(12, 'user12', 'user12', 'user12@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member')
,(13, 'user13', 'user13', 'user13@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member')
,(14, 'user14', 'user14', 'user14@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member')
,(15, 'user15', 'user15', 'user15@example.com', '$2a$04$o8noGLPldirkZe4fzitY..hQ11s2jVcQswPROshPyI7GnYDJckdci', 'member')
;
SELECT setval('users_id_seq'::regclass, (SELECT MAX(id) FROM users));

-- foo=1 has more friends than fit on the homepage
INSERT INTO friendships (from_user_id, to_user_id) VALUES
(1, 2)
,(1, 3)
,(1, 4)
-- all the user* users
,(1, 8)
,(1, 9)
,(1, 10)
,(1, 11)
,(1, 12)
,(1, 13)
,(1, 14)
,(1, 15)
;


INSERT INTO vms (from_user_id, to_user_id, markup, html, parent_vm_id)
VALUES
(1, 1, 'Test1 - Has children', 'Test - has children', null),
(1, 1, 'Child', 'Child', 1),
(1, 1, 'Test2 - No Children', 'Test2 - No children', null)
;
SELECT setval('vms_id_seq'::regclass, (SELECT MAX(id) FROM vms));

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
INSERT INTO pms (convo_id, user_id, markup, html)
VALUES
(1, 1, 'hey, self', 'hey, self'),
(2, 1, 'hey, bar', 'hey, bar'),
(2, 2, 'hey, foo', 'hey, foo'),
(3, 1, 'hey, guys', 'hey, guys'),
(3, 2, 'hey, guys', 'hey, guys')
;
SELECT setval('pms_id_seq'::regclass, (SELECT MAX(id) FROM pms));

---- Categories
INSERT INTO categories (id, title, description, pos)
VALUES
(1, 'News and Newcomers', null, 1),
(2, 'Roleplaying', null, 2),
(3, 'Test Category', null, 3),
(4, 'Mod Forums', null, 6),
(5, 'Meta', null, 5),
(6, 'Off-Topic', null, 4)
;
SELECT setval('categories_id_seq'::regclass, (SELECT MAX(id) FROM categories));

---- Forums
INSERT INTO forums (category_id, parent_forum_id, id, title, description, pos, is_roleplay, has_tags_enabled, is_arena_rp)
VALUES
-- News and Newcomers (id 1)
(1, null, 1, 'News', 'Official RPGuild News is posted here.', 1, false, false, false),
(1, null, 2, 'Introduce Yourself', 'New to RPGuild? Come say hello!', 2, false, false, false),
-- Roleplaying (id 2)
(2, null, 38, 'General Interest Checks', 'This forum is for more general interest checks. Perhaps they span multiple roleplaying subforums.', 1, false, false, false),
(2, null, 3, 'Free Roleplay', 'No standards. For roleplaying involving one-liners, few-liners, speed-posting, and for anyone who doesn''t want to have to worry about standards. Roleplays that don''t fulfill Casual standards are moved here.', 2, true, true, false),
  (2, 3, 12, 'Free Interest Checks', null, 1, false, false, false),
(2, null, 4, 'Casual Roleplay', 'Medium standards. Roleplay here if you enjoy writing at least a paragraph or two, character development, and some depth. Casual RP is more laid back and lighthearted than Advanced RP but more moderated than Free RP. It''s a good fit for most roleplayers. Acceptable spelling and grammar required.', 3, true, true, false),
  (2, 4, 13, 'Casual Interest Checks', null, 1, false, false, false),
(2, null, 5, 'Advanced Roleplay', 'Strict, highly moderated roleplay with elevated standards. Advanced RP focuses on longer posts that include character development and coherent writing ability.', 4, true, true, false),
  (2, 5, 14, 'Advanced Interest Checks', null, 1, false, false, false),
(2, null, 6, 'Arena Roleplay', 'Battle-centered roleplay.', 5, true, true, true),
  (2, 6, 15, 'Arena Interest Checks', null, 1, false, false, true),
(2, null, 7, '1x1 Roleplay', 'Two players per roleplay here.', 6, true, true, false),
  (2, 7, 16, '1x1 Interest Checks', null, 1, false, false, false),
(2, null, 42, 'Nation Roleplay', 'Create and control a nation that collides with other nations through political, economic, and diplomatic warfare.', 7, true, true, false),
  (2, 42, 43, 'Nation Interest Checks', null, 1, false, false, false),
(2, null, 39, 'Tabletop Roleplay', 'Roleplays focused on dice rolls and stat blocks where the narrative is driven by game mechanics.', 8, true, true, false),
  (2, 39, 40, 'Tabletop Interest Checks', null, 1, false, false, false),
-- Test Category (id 3)
(3, null, 31, 'Test Forum', 'Test forum features and try to break things here.', 1, false, false, false),
(3, null, 30, 'Spam Forum', 'Where people go to make me regret everything.', 2, false, false, false),
-- Off-Topic (id 4)
(6, null, 41, 'Roleplaying Discussion', 'Discussion related to roleplaying and GMing.', 1, false, false, false),
(6, null, 32, 'Member Lounge', 'Come unwind with the rest of RPG and socialize. Post your blogs, leaving threads, birthday threads, and general interest threads here.', 2, false, false, false),
(6, null, 33, 'Off-Topic Discussion', 'No spam.', 3, false, false, false),
(6, null, 34, 'Character Sheets', 'Feel free to post your character sheets here to keep track of characters, view other characters, and share your characters with the world.', 4, false, false, false),
(6, null, 35, 'The Gallery', 'Come share your own art and literary work! (Includes shops & requests)', 5, false, false, false),
(6, null, 37, 'Articles & Guides', 'User-submitted resources for helping you with your roleplay life, your forum life, and your life life.', 6, false, false, false),
-- Meta (id 5)
(5, null, 9, 'Feature Requests & Bugs', 'Share and brainstorming ideas for making RPGuild a better community.', 1, false, false, false),
(5, null, 36, 'Need Help?', 'Have a question about the site? Need to talk to Guild staff? Until I have a better solution, you can come here to get help. (Note: No more username changes allowed. We don''t rename topics. We don''t delete roleplays once other people have posted in them. There are exceptions, of course.)', 2, false, false, false),
-- [category_id, parent_forum_id, id, title, description, pos, is_roleplay]
-- Mod Forums (id 6)
(4, null, 10, 'Mod Discussion', 'Mods + Admins only', 1, false, false, false)
;
SELECT setval('forums_id_seq'::regclass, (SELECT MAX(id) FROM forums));

---- Tags

INSERT INTO tag_groups (id, title) VALUES
  (1, 'TestTags')
;
SELECT setval('tag_groups_id_seq'::regclass, (SELECT MAX(id) FROM tag_groups));

INSERT INTO tags (id, tag_group_id, title, description) VALUES
  (1, 1, 'TestTag 1', 'Just a test')
, (2, 1, 'TestTag 2', 'Just a test')
, (3, 1, 'TestTag 3', 'Just a test')
;
SELECT setval('tags_id_seq'::regclass, (SELECT MAX(id) FROM tags));

---- Topics
INSERT INTO topics (id, forum_id, title, user_id, is_hidden, is_closed, is_sticky, is_roleplay)
VALUES
 (1, 1, 'Test Topic A',        1, false, true,  false, false)  -- nonrp
,(2, 1, 'Test Topic B',        1, false, false, true,  false)  -- nonrp
,(3, 1, 'Test Topic C',        1, false, false, false, false) -- nonrp
,(4, 3, 'The Flob''s Journey', 1, false, false, false, true)  -- free-rp
;
SELECT setval('topics_id_seq'::regclass, (SELECT MAX(id) FROM topics));


-- Add tags to the flob's journey RP

INSERT INTO tags_topics (topic_id, tag_id) VALUES
  (4, 1)
, (4, 2)
, (4, 3)
;

---- Posts
INSERT INTO posts (id, topic_id, user_id, markup, html, ip_address, type, is_roleplay)
VALUES
(1, 1, 1, 'First post', 'First post', '1.2.3.4', 'ooc', false)
,(2, 2, 1, 'First post', 'First post', '1.2.3.4', 'ooc', false)
,(3, 3, 1, 'First post', 'First post', '1.2.3.4', 'ooc', false)
,(4, 4, 1, 'First IC post', 'First IC post', '1.2.3.4', 'ic', true);
SELECT setval('posts_id_seq'::regclass, (SELECT MAX(id) FROM posts));

---- Topic subscriptions
INSERT INTO topic_subscriptions (topic_id, user_id)
VALUES
(1, 1)  -- foo + nonrp
,(4, 1)  -- foo + rp (the flob's journey)
;


------------------------------------------------------------
-- STATUSES
------------------------------------------------------------

INSERT INTO statuses (user_id, text, html) VALUES
(1, 'hello', 'hello')
-- banned user
,(7, 'status 1', 'status 1')
,(7, 'status 2', 'status 2')
,(7, 'status 3', 'status 3')
,(7, 'status 4', 'status 4')
,(7, 'status 5', 'status 5')
--
,(1, 'bye', 'bye')
;


------------------------------------------------------------
-- TROPHIES
------------------------------------------------------------

INSERT INTO trophy_groups (id, title, description_markup, description_html)
VALUES
 (1, 'Test Trophy Group', 'Test', 'Test')
;

INSERT INTO trophies (id, group_id, title, awarded_count, description_markup, description_html, image_url)
VALUES
 (1, 1, 'Test Trophy', 2, 'Test', 'Test', '/img/fonzy.gif')
;

-- @foo = 1
-- @admin = 4
INSERT INTO trophies_users (user_id, trophy_id, awarded_by, n, message_markup, message_html)
VALUES
 (1, 1, 4, 1, 'A note', 'A note')
,(4, 1, 4, 2, 'Note 2', 'Note 2')
;


------------------------------------------------------------
-- ARENA
------------------------------------------------------------

INSERT INTO arena_outcomes (topic_id, user_id, outcome, profit, inserted_by)
VALUES
-- foo=1 wins 2
 (1, 1, 'WIN', 100, 1)
,(2, 1, 'WIN', 100, 1)
-- bar=2
,(1, 2, 'DRAW', 50, 1)
,(2, 2, 'LOSS', 0, 1)
;

-- foo=1
UPDATE users
SET arena_wins = 2, arena_losses = 0, arena_draws = 0, show_arena_stats = true
WHERE id = 1;

-- bar=2
UPDATE users
SET arena_wins = 0, arena_losses = 1, arena_draws = 1, show_arena_stats = true
WHERE id = 2;
