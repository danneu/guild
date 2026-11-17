# Who may read what

Read this before you load a topic, forum or post by id, list posts or topics
across topics, or create or read a notification. `AGENTS.md` links here.

## By-id loads

- Load a topic or forum by id only through `db.loadTopicFor` or
  `db.loadForumFor` (`server/db/readable.ts`). They check READ_TOPIC or
  READ_FORUM before they return a row.
- Add any new by-id topic or forum query there as a private function, never
  as an export of `server/db`.

## Paged lists

- Run a viewer's paged list of posts or topics that spans topics only through
  `server/readable.ts#fetchReadable`. It adds the read scope in SQL before
  the limit or cap, then checks each row with cancan.
- Filtering rows after the query still leaks through page sizes.
- The topic page stays out: it asks READ_POST about each post, so GMs still
  see hidden posts in their own topics.

## Notifications

- Create a notification that points at a post or a topic, read its post html
  or topic title, and list a user's subscribed topics only through the
  exports of `server/db/notifications.ts`.
- It gates each recipient and each row with READ_POST or READ_TOPIC on live
  rows. Its reads delete the notifications that fail and keep the
  subscriptions.
- Lookups by id and deletes return only pointer columns, so they need no
  gate. Most of them stay in `server/db/index.ts`.
