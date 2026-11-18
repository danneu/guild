// The only way to write post text and topic titles: a new topic, a reply, a
// tab's 0th post, a post edit, a revert to a revision, and a retitle. Only
// this module imports the raw writes in server/db/forum_text_writes.ts
// (server/parser-owners.test.ts), and server/write_census.test.ts fails on
// any other code that inserts a post or a topic or sets those columns. Other
// member text, such as bios, signatures and PMs, is not this module's.
//
// Each function renders through server/markup.ts before the write opens its
// transaction, so MarkupRejected comes before any lock. The raw write applies
// the post gap and the screening charge (docs/agents/budgets.md). After the
// commit, the charge goes to the spam classifier through
// server/services/antispam/index.ts#process; a trusted member's write has no
// charge and sends nothing. Only a new topic waits for the verdict, so that it
// can skip the intro broadcast. Every other write is screened after the
// response.
//
// nukeUser hides only the nuked account's own rows, but a co-GM can edit the
// GM's 0th posts and retitle the GM's topic. So on a NUKE verdict this module
// also hides the post or topic the actor changed but does not own, and only
// while it still holds the text that was judged: a verdict comes back late,
// and by then the owner may have fixed it. It never puts back an older text,
// which may be spam too, so a moderator decides what the row says.

// 1st
import cache3 from "./cache3";
import * as config from "./config";
import * as db from "./db";
import * as raw from "./db/forum_text_writes";
import { pool, withPgPoolTransaction } from "./db/util";
import { renderMarkup } from "./markup";
import antispam, { type SpamActor } from "./services/antispam";
import type { ScreeningCharge } from "./db/screen_budget";

type PostType = "ic" | "ooc" | "char";

// A post as the edit routes load it
type LoadedPost = { id: number; user_id: number; markup: string };

// Hands a write's charge to the classifier after the response. On a NUKE it
// then runs hideForeign, which hides what the write changed in a row the
// actor does not own; null when the row is the actor's own. Returns nothing,
// so a route has no promise to drop.
function screenInBackground(
  writer: SpamActor,
  charge: ScreeningCharge | null,
  postId: number,
  hideForeign: (() => Promise<boolean>) | null,
): void {
  antispam
    .process(writer, charge, postId)
    .then(async (finding) => {
      if (finding?.action === "NUKE" && hideForeign) await hideForeign();
    })
    .catch((err) => console.error("[forum_text] screening failed", err));
}

// The site caches a few posts' html (server/cache3.ts).
function refreshCachedPost(postId: number): void {
  if (postId === config.FAQ_POST_ID) cache3.requestUpdate("faq-post");
  if (postId === config.WELCOME_POST_ID) cache3.requestUpdate("welcome-post");
}

////////////////////////////////////////////////////////////

// Creates a topic with its opening post, and waits for the verdict on both.
// flagged is true when the classifier suspects spam, so the route can skip
// the intro broadcast. The topic is the writer's own, so a NUKE hides it.
export async function createTopic(
  writer: SpamActor,
  input: {
    forumId: number;
    ipAddress: string;
    title: string;
    markup: string;
    postType: PostType;
    isRoleplay: boolean;
    tagIds: number[];
    joinStatus: string | undefined;
  },
): Promise<{ topic: any; flagged: boolean }> {
  const html = renderMarkup(input.markup, writer);
  const { topic, charge } = await raw.createTopic({
    userId: writer.id,
    ...input,
    html,
  });
  const finding = await antispam.process(writer, charge, topic.post.id);
  return { topic, flagged: finding !== null };
}

// Creates a reply and sends its mention, quote and subscription
// notifications in the same transaction.
export async function createReply(
  writer: SpamActor,
  input: {
    topicId: number;
    isRoleplay: boolean;
    type: PostType;
    ipAddress: string;
    markup: string;
  },
): Promise<{ post: any; mentionsCount: number; quotesCount: number }> {
  const html = renderMarkup(input.markup, writer);
  const created = await withPgPoolTransaction(pool, async (pgClient) => {
    const { post, charge } = await raw.createPost(pgClient, {
      userId: writer.id,
      ipAddress: input.ipAddress,
      topicId: input.topicId,
      markup: input.markup,
      html,
      type: input.type,
      isRoleplay: input.isRoleplay,
    });
    const counts = await db.notifications.notifyNewPost(pgClient, {
      author: writer,
      postId: post.id,
      markup: input.markup,
    });
    return { post, charge, ...counts };
  });
  screenInBackground(writer, created.charge, created.post.id, null);
  const { post, mentionsCount, quotesCount } = created;
  return { post, mentionsCount, quotesCount };
}

// Creates a roleplay tab's 0th post. The tab's unique index refuses a second
// one with Postgres error 23505, which the route answers.
export async function createZerothPost(
  writer: SpamActor,
  input: {
    topicId: number;
    type: PostType;
    ipAddress: string;
    markup: string;
  },
): Promise<any> {
  const html = renderMarkup(input.markup, writer);
  const { post, charge } = await withPgPoolTransaction(pool, (pgClient) =>
    raw.createPost(pgClient, {
      userId: writer.id,
      ipAddress: input.ipAddress,
      topicId: input.topicId,
      markup: input.markup,
      html,
      type: input.type,
      isRoleplay: true,
      idx: -1,
    }),
  );
  screenInBackground(writer, charge, post.id, null);
  return post;
}

// Saves new markup for a post as a revision. Returns the saved post, or the
// loaded one when the markup is unchanged, which writes and screens nothing.
export async function editPost(
  writer: SpamActor,
  post: LoadedPost,
  input: { markup: string; reason: string | undefined },
): Promise<any> {
  if (post.markup.trim() === input.markup.trim()) return post;
  return writeEdit(writer, post, input.markup, input.reason);
}

// Puts a post back to the markup of one of its revisions, rendered again like
// any edit: a revision's stored html may come from an older renderer that
// never passed the sanitizer. Returns null when the post has no such
// revision.
export async function revertPost(
  writer: SpamActor,
  post: Omit<LoadedPost, "markup">,
  revId: number,
): Promise<any | null> {
  const markup = await db.revs.getPostRevMarkup(post.id, revId);
  if (typeof markup !== "string") return null;
  return writeEdit(writer, post, markup, `Reverted to revision ${revId}`);
}

async function writeEdit(
  writer: SpamActor,
  post: Omit<LoadedPost, "markup">,
  markup: string,
  reason: string | undefined,
): Promise<any> {
  const html = renderMarkup(markup, writer);
  const saved = await raw.updatePost(writer.id, post.id, markup, html, reason);
  refreshCachedPost(post.id);
  screenInBackground(
    writer,
    saved.charge,
    post.id,
    post.user_id === writer.id
      ? null
      : () => raw.hidePostIfMarkup(post.id, markup),
  );
  return saved.post;
}

// Sets a topic's title. The classifier reads the new title with the topic's
// opening post.
export async function retitleTopic(
  writer: SpamActor,
  topic: { id: number; user_id: number },
  title: string,
): Promise<void> {
  const { charge, openingPostId } = await raw.updateTopicTitle(
    writer.id,
    topic.id,
    title,
  );
  screenInBackground(
    writer,
    charge,
    openingPostId,
    topic.user_id === writer.id
      ? null
      : () => raw.hideTopicIfTitle(topic.id, title),
  );
}
