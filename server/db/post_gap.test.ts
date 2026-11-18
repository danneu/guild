import { beforeEach, describe, expect, it, vi } from "vitest";

// createTopic opens its own transaction on the pool; the fake database below
// stands in for it.
const current = vi.hoisted(() => ({ db: null as any }));
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  pool: {
    withTransaction: (fn: (client: unknown) => unknown) =>
      current.db.transaction(fn),
  },
}));

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

import { createPost, createTopic } from "./forum_text_writes";
import { lockSender } from "./send_budget";

const SECOND = 1000;
const T0 = new Date("2026-11-17T12:00:00Z");

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

////////////////////////////////////////////////////////////
// A fake database. It models what the gap relies on: an advisory lock held
// until its transaction ends, writes that others see only once they commit,
// and now() as the transaction's start while clock_timestamp() keeps moving.
// So it shows the order the writes run their queries in. It cannot show that
// Postgres itself serializes them; that needs a real database. The SQL is
// reviewed, not tested.

// The author's users row, with the standing server/trust.ts#readTrust would
// read for them
type User = { posts_count: number; trusted: boolean; demoted: boolean };
type Stamp = { user_id: number; ip_address: string; created_at: Date };

const newbie: User = { posts_count: 0, trusted: false, demoted: false };

function fakeDb(opts: { user?: User; ledger?: Stamp[] } = {}) {
  const user = { id: 7, uname: "newbie", ...(opts.user ?? newbie) };
  const db = {
    clock: T0,
    // Committed ratelimits rows
    ledger: [...(opts.ledger ?? [])],
    // Committed post inserts
    posts: 0,
    failPostInsert: false,
    locks: new Map<string, Promise<void>>(),
    transaction,
  };

  async function transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const startedAt = db.clock;
    const held = new Map<string, () => void>();
    const pending: ((rows: Stamp[]) => Stamp[])[] = [];
    let posts = 0;

    function visible(): Stamp[] {
      return pending.reduce((rows, op) => op(rows), db.ledger);
    }

    async function lock(key: string): Promise<void> {
      if (held.has(key)) return;
      while (db.locks.has(key)) await db.locks.get(key);
      let release!: () => void;
      db.locks.set(key, new Promise<void>((resolve) => (release = resolve)));
      held.set(key, () => {
        db.locks.delete(key);
        release();
      });
    }

    async function answer(sql: string, params: any[]): Promise<unknown[]> {
      if (/pg_advisory_xact_lock/.test(sql)) {
        await lock(params.join(":"));
        return [{}];
      }
      if (/FROM users/.test(sql)) return [user];
      if (/DELETE FROM ratelimits/.test(sql)) {
        pending.push((rows) => rows.filter((r) => r.user_id !== params[0]));
        return [];
      }
      if (/INSERT INTO ratelimits/.test(sql)) {
        const stamp = {
          user_id: params[0],
          ip_address: params[1],
          // The column's DEFAULT NOW() when no stamp is passed
          created_at: params[2] ?? startedAt,
        };
        pending.push((rows) => [...rows, stamp]);
        return [];
      }
      if (/FROM ratelimits/.test(sql)) {
        const times = visible()
          .filter((r) => r.user_id === params[0])
          .map((r) => r.created_at.getTime());
        return [
          {
            now: /clock_timestamp\(\)/.test(sql) ? db.clock : startedAt,
            last_post_at:
              times.length > 0 ? new Date(Math.max(...times)) : null,
          },
        ];
      }
      if (/screen_spends/.test(sql)) return [];
      if (/clock_timestamp\(\)/.test(sql)) return [{ now: db.clock }];
      if (/INSERT INTO topics/.test(sql)) return [{ id: 50 }];
      if (/INSERT INTO posts/.test(sql)) {
        if (db.failPostInsert) throw new Error("posts_topic_id_fkey");
        posts += 1;
        return [{ id: 100 }];
      }
      if (/INSERT INTO (post_revs|tags_topics)/.test(sql)) return [];
      throw new Error(`fake db: unexpected query ${sql}`);
    }

    const client = {
      _inTransaction: true as const,
      async query(sql: string, params: any[] = []) {
        const rows = await answer(sql, params);
        return { rows, rowCount: rows.length };
      },
    };

    try {
      const result = await fn(client);
      db.ledger = visible();
      db.posts += posts;
      return result;
    } finally {
      for (const release of held.values()) release();
    }
  }

  current.db = db;
  return db;
}

const reply = {
  userId: 7,
  ipAddress: "1.2.3.4",
  topicId: 10,
  markup: "Hi",
  html: "Hi",
  type: "ooc",
  isRoleplay: false,
};

function postReply(db: ReturnType<typeof fakeDb>, args = {}) {
  return db.transaction((c) => createPost(c, { ...reply, ...args }));
}

beforeEach(() => {
  current.db = null;
});

////////////////////////////////////////////////////////////

describe("the post gap", () => {
  // The 0-post case pins the old off-by-one: a member with no posts got the
  // 1-second floor, not the new-member wait.
  describe.each([
    ["a new member with no posts", newbie, 10],
    ["a trusted member", { posts_count: 0, trusted: true, demoted: false }, 1],
  ])("for %s", (_label, user, gapSeconds) => {
    const gap = gapSeconds * SECOND;

    it(`refuses a post ${gapSeconds} s after the last, less 1 ms`, async () => {
      const last = {
        user_id: 7,
        ip_address: "1.2.3.4",
        created_at: at(1 - gap),
      };
      const db = fakeDb({ user, ledger: [last] });

      await expect(postReply(db)).rejects.toMatchObject({
        name: "PostTooSoon",
        retryAt: at(1),
      });

      expect(db.posts).toBe(0);
      expect(db.ledger).toEqual([last]);
    });

    it(`admits a post ${gapSeconds} s after the last, and stamps it`, async () => {
      const db = fakeDb({
        user,
        ledger: [
          { user_id: 7, ip_address: "1.2.3.4", created_at: at(-gap) },
          { user_id: 7, ip_address: "5.6.7.8", created_at: at(-2 * gap) },
        ],
      });

      await postReply(db);

      expect(db.posts).toBe(1);
      expect(db.ledger).toEqual([
        { user_id: 7, ip_address: "1.2.3.4", created_at: T0 },
      ]);
    });
  });

  it("follows the account, not the network", async () => {
    // A neighbor on the same /24 posted a second ago.
    const db = fakeDb({
      ledger: [{ user_id: 8, ip_address: "1.2.3.5", created_at: at(-SECOND) }],
    });
    await postReply(db);

    // The member's next post, from another network, still waits.
    db.clock = at(SECOND);
    await expect(postReply(db, { ipAddress: "9.9.9.9" })).rejects.toMatchObject(
      { name: "PostTooSoon" },
    );
    expect(db.posts).toBe(1);
  });

  it("holds a topic and a reply to one gap", async () => {
    const db = fakeDb();
    await createTopic({
      userId: 7,
      forumId: 1,
      ipAddress: "1.2.3.4",
      title: "Hello",
      markup: "Hi",
      html: "Hi",
      postType: "ooc",
      isRoleplay: false,
    });

    db.clock = at(5 * SECOND);
    await expect(postReply(db)).rejects.toMatchObject({
      name: "PostTooSoon",
      retryAt: at(10 * SECOND),
    });
  });

  it("refuses a topic inside the gap and writes nothing", async () => {
    const db = fakeDb({
      ledger: [{ user_id: 7, ip_address: "1.2.3.4", created_at: at(-SECOND) }],
    });

    await expect(
      createTopic({
        userId: 7,
        forumId: 1,
        ipAddress: "1.2.3.4",
        title: "Hello",
        markup: "Hi",
        html: "Hi",
        postType: "ooc",
        isRoleplay: false,
      }),
    ).rejects.toMatchObject({ name: "PostTooSoon" });
    expect(db.posts).toBe(0);
  });

  // Intent: two posts sent at once land one, and the other waits its gap.
  // Why it exists: the old check read the newest row with no lock in a
  // transaction of its own, so a parallel burst all read the same old row and
  // all passed.
  it("admits one of two posts sent at once", async () => {
    const db = fakeDb();

    const results = await Promise.allSettled([postReply(db), postReply(db)]);

    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(db.posts).toBe(1);
  });

  // Intent: a post that waited on its member's lock holds its gap from when
  // it was admitted.
  // Why it exists: now() is the transaction's start. A post stamped with it
  // after a long wait behind a send would stamp a gap already over, and let
  // the next post through at once.
  it("stamps a post that waited on the lock with the time it was admitted", async () => {
    const db = fakeDb();
    // A long send by the same member holds the lock.
    let endSend!: () => void;
    const sendEnds = new Promise<void>((resolve) => (endSend = resolve));
    const send = db.transaction(async (c) => {
      await lockSender(c, 7);
      await sendEnds;
    });
    const waited = postReply(db);

    db.clock = at(60 * SECOND);
    endSend();
    await send;
    await waited;

    db.clock = at(61 * SECOND);
    await expect(postReply(db)).rejects.toMatchObject({
      name: "PostTooSoon",
      retryAt: at(70 * SECOND),
    });
  });

  it("leaves no stamp for a post that fails after admission", async () => {
    const db = fakeDb();
    db.failPostInsert = true;
    await expect(postReply(db)).rejects.toThrow("posts_topic_id_fkey");

    db.failPostInsert = false;
    await postReply(db);
    expect(db.posts).toBe(1);
  });

  // posts_topic_id_type_idx_idx caps a tab at one 0th post, and a GM setting
  // up a new roleplay's tabs should not wait between them.
  it("lets a tab's 0th post skip the gap, and stamps nothing", async () => {
    const last = { user_id: 7, ip_address: "1.2.3.4", created_at: at(-SECOND) };
    const db = fakeDb({ ledger: [last] });

    await postReply(db, { type: "ic", isRoleplay: true, idx: -1 });

    expect(db.posts).toBe(1);
    expect(db.ledger).toEqual([last]);
  });
});
