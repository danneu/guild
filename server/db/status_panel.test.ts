// Intent: the homepage status panel shows each trusted member's current
// status, newest first, one per member, on real rows in a real Postgres
// (server/testing/db.ts). /statuses and profiles still list every status.
// Why it exists: the panel listed the newest statuses from any account, and
// every visitor sees it, guests included. So one fresh account could keep the
// whole panel full of its links (hunt 261117-0852-047). The pg stubs ignore a
// query's WHERE clause, so only real rows show which rows the panel picks.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "../config";
import { closeTestDatabase, emptyTables } from "../testing/db";
import { sanitizeUserHtml } from "../user_html";
import {
  clearCurrentStatusForUserId,
  createStatus,
  deleteStatusById,
  findAllStatuses,
  findLatestStatuses,
  findLatestStatusesForUserId,
  STATUS_PANEL_WINDOW,
} from "./index";
import { pool, withPgPoolTransaction } from "./util";

vi.mock("./util", async (importOriginal) =>
  (await import("../testing/db")).onTestDatabase(
    await importOriginal<typeof import("./util")>(),
  ),
);

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest. Nothing here renders markup.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

beforeEach(emptyTables);
afterAll(closeTestDatabase);

async function createMember(
  uname: string,
  opts: { approved?: boolean; nuked?: boolean } = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `
    INSERT INTO users (uname, digest, email, slug, approved_at, is_nuked)
    VALUES ($1, '', $1 || '@example.com', $1,
      CASE WHEN $2 THEN now() END, $3)
    RETURNING id
  `,
    [uname, opts.approved ?? false, opts.nuked ?? false],
  );
  return rows[0]!.id;
}

// Posts a status as the route does, so the insert trigger moves the member's
// current status to it.
async function postStatus(userId: number, text: string): Promise<number> {
  const status = await withPgPoolTransaction(pool, (client) =>
    createStatus(client, {
      user_id: userId,
      text,
      html: sanitizeUserHtml(text),
    }),
  );
  return status.id;
}

async function panel(): Promise<string[]> {
  return (await findLatestStatuses()).map((status) => status.text);
}

describe("the homepage status panel", () => {
  it("shows each trusted member's newest status, newest first", async () => {
    const alice = await createMember("alice", { approved: true });
    const bob = await createMember("bob", { approved: true });
    await postStatus(alice, "alice 1");
    await postStatus(bob, "bob 1");
    await postStatus(alice, "alice 2");

    expect(await panel()).toEqual(["alice 2", "bob 1"]);
  });

  it("leaves out a cleared status, and does not bring back an older one", async () => {
    const alice = await createMember("alice", { approved: true });
    await postStatus(alice, "alice 1");
    await postStatus(alice, "alice 2");

    await clearCurrentStatusForUserId(alice);

    expect(await panel()).toEqual([]);
  });

  it("leaves out a deleted status, and does not bring back an older one", async () => {
    const alice = await createMember("alice", { approved: true });
    await postStatus(alice, "alice 1");
    const newest = await postStatus(alice, "alice 2");

    await deleteStatusById(newest);

    expect(await panel()).toEqual([]);
  });

  it("leaves out new and nuked members, who keep their other listings", async () => {
    const alice = await createMember("alice", { approved: true });
    const newbie = await createMember("newbie");
    const nuked = await createMember("nuked", { approved: true, nuked: true });
    await postStatus(alice, "alice 1");
    await postStatus(newbie, "newbie 1");
    await postStatus(nuked, "nuked 1");

    expect(await panel()).toEqual(["alice 1"]);
    expect((await findAllStatuses()).map((status) => status.text)).toEqual([
      "newbie 1",
      "alice 1",
    ]);
    expect(
      (await findLatestStatusesForUserId(newbie)).map((status) => status.text),
    ).toEqual(["newbie 1"]);
  });

  // Scenario: a new account posts a window's worth of statuses after Alice's,
  // which pushes hers out. Staff nuke the account, and hers shows again.
  it("reads a window of the newest statuses by members who are not nuked", async () => {
    const alice = await createMember("alice", { approved: true });
    const spammer = await createMember("spammer");
    await postStatus(alice, "alice 1");
    await pool.query(
      `
      INSERT INTO statuses (user_id, text, html)
      SELECT $1, 'spam', 'spam' FROM generate_series(1, $2)
    `,
      [spammer, STATUS_PANEL_WINDOW],
    );
    expect(await panel()).toEqual([]);

    await pool.query(`UPDATE users SET is_nuked = true WHERE id = $1`, [
      spammer,
    ]);

    expect(await panel()).toEqual(["alice 1"]);
  });

  // Scenario: a member's status waits while their posts are young, shows once
  // the posts age past the trust floor, and leaves when staff hide a post.
  // The member writes no status in between.
  it("follows the author's standing with no new status", async () => {
    const carol = await createMember("carol");
    const { rows } = await pool.query<{ id: number }>(
      `
      WITH category AS (
        INSERT INTO categories (title, pos) VALUES ('Lobby', 0) RETURNING id
      ), forum AS (
        INSERT INTO forums (category_id, title, pos)
        SELECT id, 'General', 0 FROM category
        RETURNING id
      )
      INSERT INTO topics (forum_id, user_id, title, is_roleplay)
      SELECT forum.id, $1, 'A topic', false FROM forum
      RETURNING id
    `,
      [carol],
    );
    const topic = rows[0]!.id;
    for (let i = 0; i < 6; i++) {
      await pool.query(
        `
        INSERT INTO posts (topic_id, user_id, markup, html, type, is_roleplay)
        VALUES ($1, $2, 'hi', 'hi', 'ooc', false)
      `,
        [topic, carol],
      );
    }
    await postStatus(carol, "carol 1");
    expect(await panel()).toEqual([]);

    await pool.query(
      `
      UPDATE posts
      SET created_at = created_at - make_interval(secs => $1)
      WHERE user_id = $2
    `,
      [config.TRUST_MIN_POST_AGE_SECONDS + 60, carol],
    );
    expect(await panel()).toEqual(["carol 1"]);

    await pool.query(
      `
      UPDATE posts SET is_hidden = true
      WHERE id = (SELECT min(id) FROM posts WHERE user_id = $1)
    `,
      [carol],
    );
    expect(await panel()).toEqual([]);
  });
});
