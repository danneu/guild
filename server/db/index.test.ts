import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "./util";
import {
  createFriendship,
  issueResetToken,
  likeStatus,
  ratePost,
  replacePasswordTx,
  unnukeUser,
  updateUserActiveTrophyId,
  updateUserRole,
} from "./index";
import { TooManyFriends } from "./refusals";

// These pin the SQL text and the bound params each write sends.
vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  pool: { query: vi.fn(), withTransaction: vi.fn() },
}));

// server/bbcode.js loads cache3 with a CommonJS require that vitest cannot
// resolve to a .ts file. Nothing tested here renders markup.
vi.mock("../bbcode", () => ({ default: vi.fn() }));

const query = vi.mocked(pool.query) as any;

function lastCall(): [string, unknown[] | undefined] {
  const call = query.mock.calls.at(-1);
  return [call[0], call[1]];
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
  vi.mocked(pool.withTransaction).mockReset();
});

describe("updateUserActiveTrophyId", () => {
  const userId = 7;
  const trophyId = 3;

  // Intent: the write itself refuses a trophy the user was never awarded.
  // Why it exists: the rule used to live in a separate lookup at the one
  // callsite, so a route that skipped it could set any trophy on any user.
  it("only sets a trophy the user holds", async () => {
    await updateUserActiveTrophyId(userId, trophyId);

    const [sql, params] = lastCall();
    expect(sql).toMatch(/SET active_trophy_id = \$2\s+WHERE id = \$1\s+AND/);
    expect(sql).toMatch(
      /EXISTS \(\s*SELECT 1\s+FROM trophies_users\s+WHERE user_id = \$1\s+AND trophy_id = \$2\s*\)/,
    );
    expect(params).toEqual([userId, trophyId]);
  });

  it("reports whether a row changed", async () => {
    await expect(updateUserActiveTrophyId(userId, trophyId)).resolves.toBe(
      true,
    );

    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(updateUserActiveTrophyId(userId, trophyId)).resolves.toBe(
      false,
    );
  });
});

describe("replacePasswordTx", () => {
  const userId = 42;
  const digest = "$2a$10$new-digest";
  const newSession = { id: "0190e3a0-0000-7000-8000-0000000000aa" };

  // Answers by SQL text, so the test pins which statements run, not how many.
  function makePgClient() {
    const clientQuery = vi.fn(async (sql: string, _params?: unknown[]) =>
      /INSERT INTO sessions/.test(sql) ? { rows: [newSession] } : { rows: [] },
    );
    return { _inTransaction: true, query: clientQuery } as any;
  }

  // Intent: replacing a password revokes every grant the old credential gave
  // before it issues the one new session.
  // Why it exists: hunt finding 261026-0911-013. A reset left an intruder's
  // sessions (up to a year with remember-me) and a staged email-change link
  // alive, so the owner could not lock them out.
  // Scenario: user 42 resets. All of the user's sessions, reset tokens and
  // staged email links are deleted, then the new session is inserted.
  it("revokes sessions, reset tokens and staged email links before the new session", async () => {
    const pgClient = makePgClient();

    const session = await replacePasswordTx(pgClient, userId, digest, {
      ipAddress: "203.0.113.7",
      interval: "1 day",
    });

    expect(session).toBe(newSession);
    // A write sent to the pool would escape the transaction.
    expect(query).not.toHaveBeenCalled();

    const calls: [string, unknown[]][] = pgClient.query.mock.calls;
    expect(calls).toContainEqual([
      expect.stringMatching(/UPDATE users\s+SET digest = \$1/),
      [digest, userId],
    ]);

    const insertAt = calls.findIndex(([sql]) =>
      /INSERT INTO sessions/.test(sql),
    );
    expect(insertAt).toBeGreaterThanOrEqual(0);

    for (const table of [
      "sessions",
      "reset_tokens",
      "email_verification_tokens",
    ]) {
      // Keyed on the user alone: an extra condition would spare some rows.
      const revoke = new RegExp(
        `DELETE FROM ${table}\\s+WHERE user_id = \\$1\\s*$`,
      );
      const at = calls.findIndex(
        ([sql, params]) =>
          revoke.test(sql) &&
          JSON.stringify(params) === JSON.stringify([userId]),
      );
      expect(at, `DELETE FROM ${table} for the user`).toBeGreaterThanOrEqual(0);
      expect(at, `DELETE FROM ${table} before the new session`).toBeLessThan(
        insertAt,
      );
    }
  });
});

////////////////////////////////////////////////////////////
// Per-account limits
//
// Intent: each limit is read and enforced inside the write it limits, in that
// write's transaction, against the database clock.
// Why it exists: hunt finding 261117-0852-031. POST /forgot read the active
// reset token and then inserted one in separate pool queries, so requests at
// once for one address each mailed a link. The rating gap, the status-like
// gap and the friend cap had the same shape. The races rest on lockSender,
// which a stub cannot run; these pin each limit on both sides of its
// boundary.

// The database clock
const T0 = new Date("2026-11-17T12:00:00Z");

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

// A client in a transaction. pool.withTransaction runs on it, and it answers
// each statement but the lock with answer(sql, params).
function txClient(answer: (sql: string, params: unknown[]) => unknown[]) {
  const client = {
    _inTransaction: true,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const rows = /pg_advisory_xact_lock/.test(sql)
        ? [{}]
        : answer(sql, params);
      return { rows, rowCount: rows.length };
    }),
  } as any;
  vi.mocked(pool.withTransaction).mockImplementation(async (fn: any) =>
    fn(client),
  );
  return client;
}

// The params of each INSERT INTO table the client ran
function inserts(client: any, table: string): unknown[][] {
  return client.query.mock.calls
    .filter(([sql]: [string]) =>
      new RegExp(`INSERT INTO ${table}\\b`).test(sql),
    )
    .map(([, params]: [string, unknown[]]) => params);
}

describe("per-account limits", () => {
  beforeEach(() => {
    // A statement on the pool would run outside the write's transaction.
    query.mockRejectedValue(new Error("query outside the write's transaction"));
  });

  describe("issueResetToken", () => {
    const userId = 42;
    const issued = { user_id: userId, token: "a-new-token", created_at: T0 };

    function resetTokens(lastExpiredAt: Date | null) {
      return txClient((sql) => {
        if (/INSERT INTO reset_tokens/.test(sql)) return [issued];
        if (/FROM reset_tokens/.test(sql)) {
          return [{ now: T0, last_expired_at: lastExpiredAt }];
        }
        throw new Error(`unexpected query: ${sql}`);
      });
    }

    it("issues no token while the last one is still active", async () => {
      const client = resetTokens(T0);

      await expect(issueResetToken(userId)).resolves.toBeNull();
      expect(inserts(client, "reset_tokens")).toEqual([]);
    });

    it("issues a token once the last one has expired", async () => {
      const client = resetTokens(at(-1));

      await expect(issueResetToken(userId)).resolves.toEqual(issued);
      expect(inserts(client, "reset_tokens")).toEqual([
        [userId, expect.any(String), T0],
      ]);
    });
  });

  describe("ratePost", () => {
    const props = {
      post_id: 100,
      from_user_id: 7,
      from_user_uname: "Rater",
      to_user_id: 8,
      type: "like" as const,
    };
    const rating = { post_id: props.post_id, type: props.type };

    function ratings(lastAt: Date | null) {
      return txClient((sql) => {
        if (/INSERT INTO ratings/.test(sql)) return [rating];
        if (/FROM ratings/.test(sql)) return [{ now: T0, last_at: lastAt }];
        throw new Error(`unexpected query: ${sql}`);
      });
    }

    it("refuses a rating 3 s after the last, less 1 ms", async () => {
      const client = ratings(at(1 - 3000));

      await expect(ratePost(props)).resolves.toEqual({ type: "TOO_SOON" });
      expect(inserts(client, "ratings")).toEqual([]);
    });

    it("rates a post 3 s after the last, stamped with the database clock", async () => {
      const client = ratings(at(-3000));

      await expect(ratePost(props)).resolves.toEqual({
        type: "RATED",
        rating,
      });
      expect(inserts(client, "ratings")).toEqual([
        [7, "Rater", 100, "like", 8, T0],
      ]);
    });
  });

  describe("likeStatus", () => {
    const like = { user_id: 7, status_id: 30 };

    function statusLikes(lastAt: Date | null) {
      return txClient((sql) => {
        if (/INSERT INTO status_likes/.test(sql)) return [{}];
        if (/UPDATE statuses/.test(sql)) return [];
        if (/FROM status_likes/.test(sql))
          return [{ now: T0, last_at: lastAt }];
        throw new Error(`unexpected query: ${sql}`);
      });
    }

    it("refuses a like 3 s after the last, less 1 ms", async () => {
      const client = statusLikes(at(1 - 3000));

      await expect(likeStatus(like)).resolves.toEqual({ type: "TOO_SOON" });
      expect(inserts(client, "status_likes")).toEqual([]);
    });

    it("likes a status 3 s after the last, stamped with the database clock", async () => {
      const client = statusLikes(at(-3000));

      await expect(likeStatus(like)).resolves.toEqual({ type: "LIKED" });
      expect(inserts(client, "status_likes")).toEqual([
        [like.status_id, like.user_id, T0],
      ]);
    });
  });

  describe("createFriendship", () => {
    function friendships(count: number) {
      return txClient((sql) => {
        if (/INSERT INTO friendships/.test(sql)) return [];
        if (/FROM friendships/.test(sql)) return [{ count }];
        throw new Error(`unexpected query: ${sql}`);
      });
    }

    it("adds a 100th friend", async () => {
      const client = friendships(99);

      await createFriendship(7, 8);

      expect(inserts(client, "friendships")).toEqual([[7, 8]]);
    });

    it("refuses a 101st friend", async () => {
      const client = friendships(100);

      await expect(createFriendship(7, 8)).rejects.toBeInstanceOf(
        TooManyFriends,
      );
      expect(inserts(client, "friendships")).toEqual([]);
    });
  });
});

describe("role writes", () => {
  const actorId = 9;
  const userId = 42;

  type UserRow = { id: number; role: string; is_nuked: boolean };

  // A client in a transaction over a users table holding `rows`. A locking
  // read returns the rows it names; every other statement is a write.
  function makeTxClient(rows: UserRow[]) {
    const clientQuery = vi.fn(async (sql: any, params?: unknown[]) => {
      const text: string = typeof sql === "string" ? sql : sql.text;
      const values: any = params ?? sql.values;
      if (/FOR (NO KEY )?UPDATE/.test(text)) {
        const ids: number[] = values.flat();
        return { rows: rows.filter((row) => ids.includes(row.id)) };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { _inTransaction: true, query: clientQuery } as any;
    vi.mocked(pool.withTransaction).mockImplementation(async (fn: any) =>
      fn(client),
    );
    return client;
  }

  // Each statement other than the locking read, as [text, values]
  function writes(client: any): [string, unknown][] {
    return client.query.mock.calls
      .map(([sql, params]: [any, unknown]) =>
        typeof sql === "string" ? [sql, params] : [sql.text, sql.values],
      )
      .filter(([text]: [string]) => !/FOR (NO KEY )?UPDATE/.test(text));
  }

  function row(id: number, role: string, is_nuked = false): UserRow {
    return { id, role, is_nuked };
  }

  describe("updateUserRole", () => {
    // Intent: the write asks UPDATE_USER_ROLE about the roles the actor and
    // the account hold when it writes, read under a row lock.
    // Why it exists: the grant limit lived only in PUT /users/:slug/role,
    // which checks the roles it loaded before the write (hunt
    // 261117-0852-014). A route that skips the check, or a role that changes
    // in between, must not reach the write.
    // Scenario: a mod opens a member's edit page, an admin then makes that
    // member an admin, and the mod's submit to member arrives.
    it.each([
      ["an account made admin since the route loaded it", "mod", "admin"],
      ["an actor demoted since their session loaded", "member", "member"],
    ])("refuses %s", async (_case, actorRole, userRole) => {
      const client = makeTxClient([
        row(actorId, actorRole),
        row(userId, userRole),
      ]);

      await expect(
        updateUserRole({ actorId, userId, role: "member" }),
      ).rejects.toThrow(/UPDATE_USER_ROLE/);
      expect(writes(client)).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it("writes the role the live rows allow", async () => {
      const client = makeTxClient([row(actorId, "mod"), row(userId, "member")]);

      await updateUserRole({ actorId, userId, role: "pwmod" });

      expect(writes(client)).toEqual([
        [
          expect.stringMatching(/UPDATE users\s+SET role = \$1/),
          ["pwmod", userId],
        ],
      ]);
    });
  });

  describe("unnukeUser", () => {
    // Intent: the unnuke asks UNNUKE_USER about the live rows, read under a
    // row lock, before it unbans and unhides anything.
    // Why it exists: unnuke asked only the route's NUKE_USER check, so a mod
    // could demote a conmod to member and unhide every post staff hid
    // (hunt 261117-0852-014).
    // Scenario: a mod unnukes a nuked conmod, or an account another staff
    // member already unnuked.
    it.each([
      ["a mod unnuking a conmod", row(userId, "conmod", true)],
      ["an account that is no longer nuked", row(userId, "member", false)],
    ])("refuses %s", async (_case, user) => {
      const client = makeTxClient([row(actorId, "mod"), user]);

      await expect(unnukeUser({ actorId, userId })).rejects.toThrow(
        /UNNUKE_USER/,
      );
      expect(writes(client)).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it("unbans and unhides a nuked spambot", async () => {
      const client = makeTxClient([
        row(actorId, "mod"),
        row(userId, "banned", true),
      ]);

      await unnukeUser({ actorId, userId });

      expect(writes(client)).toEqual([
        [expect.stringMatching(/UPDATE users SET role = 'member'/), [userId]],
        [
          expect.stringMatching(/UPDATE topics SET is_hidden = false/),
          [userId],
        ],
        [expect.stringMatching(/UPDATE posts SET is_hidden = false/), [userId]],
        [expect.stringMatching(/DELETE FROM nuked_users/), [userId]],
      ]);
    });
  });
});
