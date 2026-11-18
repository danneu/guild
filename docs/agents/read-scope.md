# Who may read what

Read this before you load a topic, forum or post by id, list posts or topics
across topics, create or read a notification, or read text a member wrote
outside posts and topics. `AGENTS.md` links here.

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

## Nuked authors

- `server/db/index.ts#nukeUser` bans the account and hides its topics and
  posts. It leaves the rest of what the account wrote in place, such as its
  visitor messages, PMs, dice campaigns, statuses and album images.
- So a read that a page shows a member's text from (html, markup, a title, a
  note or a description) leaves out rows whose author has `users.is_nuked`.
  Each reader does it in its own SQL, before any limit. Nothing fails when a
  new reader forgets it.
- It reads the live flag, so unnuke brings everything back. Hiding a convo or
  a top-level VM hides the members' replies in it too. Cached counts still
  count hidden rows.
- A read that returns only ids, counts or pointer columns stays raw, so hiding
  a row never drops a row that points at it. The inbox keeps a member's convo
  whose latest PM came from a nuked participant
  (`server/db/convos.ts#findConvosInvolvingUserId`).
- A load that a route only acts on, and never shows, stays raw too, so staff
  can still delete what a nuke hid (`server/db/vms.ts#getVmById`). Staff take
  down a nuked account's images with REMOVE_UPLOADS, whose confirm page counts
  them raw.
- The notification feed deletes rows from a nuked sender, and rows whose convo
  or VM a nuked member wrote (`server/db/notifications.ts#listFeed`). Unnuke
  does not bring those rows back.
