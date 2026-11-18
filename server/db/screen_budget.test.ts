import { beforeEach, describe, expect, it, vi } from "vitest";

// The writes that charge open their own transaction on the pool; the stub
// client below stands in for it.
const current = vi.hoisted(() => ({ client: null as any }));
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  pool: {
    withTransaction: (fn: (client: unknown) => unknown) => fn(current.client),
  },
}));

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

import * as config from "../config";
import {
  createPost,
  createTopic,
  updatePost,
  updateTopicTitle,
} from "./forum_text_writes";
import {
  decideScreening,
  ScreeningBudgetExceeded,
  spendScreening,
  type ScreenSpend,
} from "./screen_budget";
import type { Standing } from "./send_budget";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = new Date("2026-11-17T12:00:00Z");
const LIMITS = { callsPerMinute: 3, unitsPerHour: 1000, unitsPerDay: 2000 };

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function spends(...list: [number, Date][]): ScreenSpend[] {
  return list.map(([cost, created_at], i) => ({
    id: String(i + 1),
    cost,
    created_at,
  }));
}

////////////////////////////////////////////////////////////
// A pg client stub that answers each query the way Postgres would for a
// screened write. vitest cannot run Postgres here, so the SQL itself is
// reviewed, not tested.

type User = { approved_at: Date | null; posts_count: number };

const newbie: User = { approved_at: null, posts_count: 1 };
const untrusted: Standing = {
  id: 7,
  uname: "newbie",
  posts_count: 1,
  trusted: false,
};

function makePgClient(opts: { user?: User; ledger?: ScreenSpend[] } = {}) {
  const user = opts.user ?? newbie;
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    const rows = ((): unknown[] => {
      if (/pg_advisory_xact_lock/.test(sql)) return [];
      if (/FROM users/.test(sql)) return [{ id: 7, uname: "newbie", ...user }];
      // The post gap (server/db/post_gap.ts): no earlier post
      if (/(INSERT INTO|DELETE FROM) ratelimits/.test(sql)) return [];
      if (/FROM ratelimits/.test(sql))
        return [{ now: NOW, last_post_at: null }];
      if (/clock_timestamp\(\)/.test(sql)) return [{ now: NOW }];
      if (/(INSERT INTO|DELETE FROM) screen_spends/.test(sql)) return [];
      if (/FROM screen_spends/.test(sql)) return opts.ledger ?? [];
      if (/FROM topics t/.test(sql)) {
        return [
          {
            title: "Old title",
            opening_post_id: 10,
            opening_markup: "Opening post",
          },
        ];
      }
      if (/INSERT INTO (topics|posts)|UPDATE (topics|posts)/.test(sql)) {
        return [{ id: 10 }];
      }
      return [];
    })();
    return { rows, rowCount: rows.length };
  });
  const client = { _inTransaction: true as const, query } as any;
  current.client = client;
  return client;
}

function sqlOf(pgClient: any): string[] {
  return pgClient.query.mock.calls.map(([sql]: [string]) => sql);
}

function indexOfSql(pgClient: any, pattern: RegExp): number {
  return sqlOf(pgClient).findIndex((sql) => pattern.test(sql));
}

function paramsOf(pgClient: any, pattern: RegExp): unknown[][] {
  return pgClient.query.mock.calls
    .filter(([sql]: [string]) => pattern.test(sql))
    .map(([, params]: [string, unknown[]]) => params);
}

beforeEach(() => {
  current.client = null;
});

////////////////////////////////////////////////////////////

describe("decideScreening", () => {
  it("fits a charge when every window has room", () => {
    const decision = decideScreening(
      spends([9, ago(30 * SECOND)], [9, ago(10 * SECOND)]),
      9,
      NOW,
      LIMITS,
    );

    expect(decision).toEqual({ retryAt: null, expired: [] });
  });

  it("paces calls: a fourth call within a minute waits for the oldest", () => {
    const burst = spends(
      [9, ago(59 * SECOND)],
      [9, ago(30 * SECOND)],
      [9, ago(10 * SECOND)],
    );
    expect(decideScreening(burst, 9, NOW, LIMITS).retryAt).toEqual(
      new Date(NOW.getTime() + 1 * SECOND),
    );

    const spaced = spends(
      [9, ago(60 * SECOND)],
      [9, ago(30 * SECOND)],
      [9, ago(10 * SECOND)],
    );
    expect(decideScreening(spaced, 9, NOW, LIMITS).retryAt).toBeNull();
  });

  it("bounds the units an hour", () => {
    const inside = spends([995, ago(59 * MINUTE)]);
    expect(decideScreening(inside, 9, NOW, LIMITS).retryAt).toEqual(
      new Date(NOW.getTime() + 1 * MINUTE),
    );
    // A charge that lands exactly on the budget fits.
    expect(decideScreening(inside, 5, NOW, LIMITS).retryAt).toBeNull();

    const left = spends([995, ago(60 * MINUTE)]);
    expect(decideScreening(left, 9, NOW, LIMITS).retryAt).toBeNull();
  });

  it("bounds the units a day", () => {
    const inside = spends([995, ago(23 * HOUR)], [995, ago(2 * HOUR)]);
    expect(decideScreening(inside, 15, NOW, LIMITS).retryAt).toEqual(
      new Date(NOW.getTime() + 1 * HOUR),
    );

    const left = spends([995, ago(24 * HOUR)], [995, ago(2 * HOUR)]);
    expect(decideScreening(left, 15, NOW, LIMITS).retryAt).toBeNull();
  });

  it("waits for the window that frees last", () => {
    // The minute frees in 1 s, the hour in 1 min.
    const both = spends(
      [900, ago(59 * MINUTE)],
      [9, ago(59 * SECOND)],
      [9, ago(30 * SECOND)],
      [9, ago(10 * SECOND)],
    );

    expect(decideScreening(both, 90, NOW, LIMITS).retryAt).toEqual(
      new Date(NOW.getTime() + 1 * MINUTE),
    );
  });

  it("names the spends no window counts any more", () => {
    const decision = decideScreening(
      spends([9, ago(DAY + 1)], [9, ago(DAY)], [9, ago(DAY - 1)]),
      9,
      NOW,
      LIMITS,
    );

    expect(decision.expired).toEqual(["1", "2"]);
  });
});

describe("spendScreening", () => {
  it("does not screen a trusted actor and touches no ledger", async () => {
    const pgClient = makePgClient();

    const charge = await spendScreening(
      pgClient,
      { ...untrusted, trusted: true },
      { title: null, body: "hi" },
    );

    expect(charge).toBeNull();
    expect(pgClient.query).not.toHaveBeenCalled();
  });

  it("stamps the charge with the clock it decided with", async () => {
    const pgClient = makePgClient();

    const charge = await spendScreening(pgClient, untrusted, {
      title: null,
      body: "hi",
    });

    expect(paramsOf(pgClient, /INSERT INTO screen_spends/)).toEqual([
      [untrusted.id, charge!.cost, NOW],
    ]);
  });

  // Intent: the charge carries the exact payload it was priced from, once.
  // Why it exists: a payload built anywhere else could send more than its
  // write paid for, and a charge used twice would pay for one call of two.
  it("hands out the payload it priced, once", async () => {
    const charge = await spendScreening(makePgClient(), untrusted, {
      title: "Hello",
      body: "My first post",
    });

    expect(JSON.parse(charge!.take())).toEqual({
      username: "newbie",
      title: "Hello",
      body: "My first post",
    });
    expect(() => charge!.take()).toThrow(/one call/);
  });

  // Escapes and multi-byte text pay for the bytes they send, not their
  // length. Each body is 1024 characters; a call costs 8 units plus one per
  // started KiB of its payload, which here adds 44 bytes around the body.
  it.each([
    ["ASCII", "a", 10],
    ["two-byte", "é", 11],
    ["three-byte", "€", 12],
    ["escaped", "\u0001", 15],
  ])("prices %s text by its payload bytes", async (_label, char, cost) => {
    const charge = await spendScreening(makePgClient(), untrusted, {
      title: null,
      body: char.repeat(1024),
    });

    expect(charge!.cost).toBe(cost);
  });

  it("refuses past the budget and records nothing", async () => {
    const pgClient = makePgClient({
      ledger: spends([config.SCREEN_BUDGET_PER_HOUR, ago(MINUTE)]),
    });

    await expect(
      spendScreening(pgClient, untrusted, { title: null, body: "hi" }),
    ).rejects.toBeInstanceOf(ScreeningBudgetExceeded);

    expect(paramsOf(pgClient, /INSERT INTO screen_spends/)).toEqual([]);
  });

  it("deletes expired spends by id", async () => {
    const pgClient = makePgClient({
      ledger: spends([9, ago(DAY + 1)], [9, ago(HOUR)]),
    });

    await spendScreening(pgClient, untrusted, { title: null, body: "hi" });

    expect(paramsOf(pgClient, /DELETE FROM screen_spends/)).toEqual([[["1"]]]);
  });
});

////////////////////////////////////////////////////////////

describe("screened writes", () => {
  const post = { ipAddress: "1.2.3.4", markup: "Hi", html: "Hi" };
  const writes = [
    {
      name: "createPost",
      insert: /INSERT INTO posts/,
      run: (c: any) =>
        createPost(c, {
          userId: 7,
          topicId: 10,
          type: "ooc",
          isRoleplay: false,
          ...post,
        }),
    },
    {
      name: "createPost (0th post)",
      insert: /INSERT INTO posts/,
      run: (c: any) =>
        createPost(c, {
          userId: 7,
          topicId: 10,
          type: "ic",
          isRoleplay: true,
          idx: -1,
          ...post,
        }),
    },
    {
      name: "createTopic",
      insert: /INSERT INTO topics/,
      run: () =>
        createTopic({
          userId: 7,
          forumId: 1,
          title: "Hello",
          postType: "ooc",
          isRoleplay: false,
          ...post,
        }),
    },
    {
      name: "updatePost",
      insert: /UPDATE posts/,
      run: () => updatePost(7, 10, "Edited", "Edited", undefined),
    },
    {
      name: "updateTopicTitle",
      insert: /UPDATE topics/,
      run: () => updateTopicTitle(7, 9, "New title"),
    },
  ];

  for (const write of writes) {
    it(`${write.name} locks the actor, then pays before it writes`, async () => {
      const pgClient = makePgClient();

      const { charge } = await write.run(pgClient);

      expect(charge).not.toBeNull();
      expect(sqlOf(pgClient)[0]).toMatch(/pg_advisory_xact_lock/);
      expect(indexOfSql(pgClient, /INSERT INTO screen_spends/)).toBeLessThan(
        indexOfSql(pgClient, write.insert),
      );
    });

    it(`${write.name} writes nothing past the budget`, async () => {
      const pgClient = makePgClient({
        ledger: spends([config.SCREEN_BUDGET_PER_HOUR, ago(MINUTE)]),
      });

      await expect(write.run(pgClient)).rejects.toBeInstanceOf(
        ScreeningBudgetExceeded,
      );

      expect(indexOfSql(pgClient, write.insert)).toBe(-1);
    });
  }

  it("a retitle pays for the new title with the opening post", async () => {
    makePgClient();

    const { charge } = await updateTopicTitle(7, 9, "New title");

    expect(JSON.parse(charge!.take())).toEqual({
      username: "newbie",
      title: "New title",
      body: "Opening post",
    });
  });

  it("a trusted actor's write pays nothing", async () => {
    const pgClient = makePgClient({
      user: { approved_at: NOW, posts_count: 1 },
    });

    const { charge } = await updatePost(7, 10, "Edited", "Edited", undefined);

    expect(charge).toBeNull();
    expect(indexOfSql(pgClient, /screen_spends/)).toBe(-1);
  });

  it("an unchanged title pays nothing", async () => {
    const pgClient = makePgClient();

    const sameTitle = await updateTopicTitle(7, 9, "Old title");

    expect(sameTitle.charge).toBeNull();
    expect(indexOfSql(pgClient, /screen_spends/)).toBe(-1);
  });
});
