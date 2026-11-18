// Intent: signup caps how many accounts one network opens in a trailing
// window. The cap counts the users rows themselves, so these run on real rows
// in a real Postgres (server/testing/db.ts), stamped relative to its now().
// Why it exists: nothing limited how many accounts one network opened, and
// each per-account limit, such as the send budget, multiplies by the accounts
// a bot makes (hunt 261117-0852-006).

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SignupPermit } from "../signup_gate";
import { closeTestDatabase, emptyTables } from "../testing/db";
import { whenNetworkFits } from "./accounts";
import { createUserWithSession } from "./index";
import { pool } from "./util";

vi.mock("./util", async (importOriginal) =>
  (await import("../testing/db")).onTestDatabase(
    await importOriginal<typeof import("./util")>(),
  ),
);

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest. Nothing here renders markup.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));
// A real digest costs bcrypt work and decides nothing here.
vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  hashPassword: vi.fn(async () => "digest"),
}));

// Set here, so no test rests on the defaults in server/config.ts.
const { LIMIT, WINDOW_SECONDS } = vi.hoisted(() => ({
  LIMIT: 3,
  WINDOW_SECONDS: 60 * 60,
}));
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  SIGNUP_NETWORK_LIMIT: LIMIT,
  SIGNUP_NETWORK_WINDOW_SECONDS: WINDOW_SECONDS,
}));

beforeEach(emptyTables);
afterAll(closeTestDatabase);

const MINUTE = 60;
// Two hosts on one network (one /24), and a host on another
const HOST = "203.0.113.7";
const NEIGHBOR = "203.0.113.200";
const ELSEWHERE = "198.51.100.7";

// The gate is not under test here.
const permit = {} as SignupPermit;

let signups = 0;

function signUp(ipAddress: string) {
  signups++;
  return createUserWithSession(permit, {
    uname: `Newcomer ${signups}`,
    ipAddress,
    password: "secret1",
    email: `newcomer${signups}@example.com`,
  });
}

// `count` accounts made from `ip`, `ageSeconds` before the database's now()
async function seedSignups(ip: string, count: number, ageSeconds: number) {
  await pool.query(
    `
    INSERT INTO users (uname, digest, email, slug, registration_ip, created_at)
    SELECT s, '', s || '@example.com', s, $1::inet,
      now() - make_interval(secs => $3)
    FROM (
      SELECT 'seed-' || gen_random_uuid() AS s FROM generate_series(1, $2)
    ) AS seeds
  `,
    [ip, count, ageSeconds],
  );
}

async function rowCounts() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM unames) AS unames,
      (SELECT count(*)::int FROM sessions) AS sessions
  `);
  return rows[0];
}

describe("createUserWithSession network cap", () => {
  // Scenario: a bot signs up again and again from one network.
  it("admits a network up to the limit, then refuses it and writes nothing", async () => {
    for (let i = 0; i < LIMIT; i++) {
      await expect(signUp(HOST)).resolves.toMatchObject({ type: "CREATED" });
    }

    await expect(signUp(NEIGHBOR)).resolves.toEqual({ type: "NETWORK_LIMIT" });
    expect(await rowCounts()).toEqual({
      users: LIMIT,
      unames: LIMIT,
      sessions: LIMIT,
    });
  });

  it("counts a signup while it is inside the window", async () => {
    await seedSignups(HOST, LIMIT, WINDOW_SECONDS - MINUTE);

    await expect(signUp(HOST)).resolves.toEqual({ type: "NETWORK_LIMIT" });
  });

  it("stops counting a signup once the window has passed it", async () => {
    await seedSignups(HOST, LIMIT, WINDOW_SECONDS + MINUTE);

    await expect(signUp(HOST)).resolves.toMatchObject({ type: "CREATED" });
  });

  // A network is an IPv4 /24 or an IPv6 /48 (sql/1-schema.sql#ip_root).
  it("counts each network apart", async () => {
    await seedSignups(HOST, LIMIT, MINUTE);
    await seedSignups("2001:db8:1::1", LIMIT, MINUTE);

    await expect(signUp(ELSEWHERE)).resolves.toMatchObject({ type: "CREATED" });
    await expect(signUp("2001:db8:2::1")).resolves.toMatchObject({
      type: "CREATED",
    });
    await expect(signUp(NEIGHBOR)).resolves.toEqual({ type: "NETWORK_LIMIT" });
    await expect(signUp("2001:db8:1:ffff::2")).resolves.toEqual({
      type: "NETWORK_LIMIT",
    });
  });

  // Intent: two signups from one network take one lock and hold it while
  // they count and insert users rows; signups from two networks take two.
  // Why it exists: without the lock, signups at once from one network each
  // count the rows before any of them commits, and all get in.
  // Limit: PGlite serves one session, so two signups cannot race here. This
  // shows which lock each signup holds while it reads and writes users, not
  // that Postgres makes a second session wait on it.
  it("holds its network's lock whenever it reads or writes users", async () => {
    const host = onlyLock(await locksOnUsers(HOST));

    expect(onlyLock(await locksOnUsers(NEIGHBOR))).toBe(host);
    expect(onlyLock(await locksOnUsers(ELSEWHERE))).not.toBe(host);
  });
});

// The advisory locks the session holds, one "classid:objid:objsubid" each
const HELD_LOCKS = `
  SELECT coalesce(array_agg(classid || ':' || objid || ':' || objsubid), '{}')
    AS held
  FROM pg_locks
  WHERE locktype = 'advisory' AND granted
`;

// Signs up from `ip` and returns, for each statement that names the users
// table, the advisory locks its transaction held just before it ran.
async function locksOnUsers(ip: string): Promise<string[][]> {
  const withTransaction = pool.withTransaction.bind(pool);
  const seen: string[][] = [];
  const spy = vi
    .spyOn(pool, "withTransaction")
    .mockImplementation((fn: (client: any) => Promise<unknown>) =>
      withTransaction((client) => {
        const query = client.query.bind(client) as any;
        const watched = new Proxy(client, {
          get(target, prop, receiver) {
            if (prop !== "query") return Reflect.get(target, prop, receiver);
            return async (sql: string, params?: unknown[]) => {
              if (/\busers\b/.test(sql)) {
                seen.push((await query(HELD_LOCKS)).rows[0].held);
              }
              return query(sql, params);
            };
          },
        });
        return fn(watched);
      }),
    );
  try {
    await expect(signUp(ip)).resolves.toMatchObject({ type: "CREATED" });
  } finally {
    spy.mockRestore();
  }
  return seen;
}

// The one lock a signup held through every statement on users
function onlyLock(seen: string[][]): string {
  expect(seen).not.toEqual([]);
  for (const held of seen) {
    expect(held).toEqual(seen[0]);
  }
  expect(seen[0]).toHaveLength(1);
  return seen[0]![0]!;
}

describe("whenNetworkFits", () => {
  // The database clock
  const T0 = new Date("2026-11-17T12:00:00Z");
  const WINDOW_MS = WINDOW_SECONDS * 1000;

  function at(ms: number): Date {
    return new Date(T0.getTime() + ms);
  }

  // The newest `count` signups, one a second, newest first
  function recent(count: number): Date[] {
    return Array.from({ length: count }, (_, i) => at(-1000 * (i + 1)));
  }

  function fits(newest: Date[]) {
    return whenNetworkFits(newest, T0, LIMIT, WINDOW_SECONDS);
  }

  it("admits a network one below the limit", () => {
    expect(fits(recent(LIMIT - 1))).toBeNull();
  });

  it("refuses a network at the limit until its oldest signup leaves", () => {
    const newest = recent(LIMIT);
    expect(fits(newest)).toEqual(
      new Date(newest.at(-1)!.getTime() + WINDOW_MS),
    );
  });

  // Only the limit-th newest decides: the network frees up when it leaves,
  // whatever older signups remain.
  it("refuses a network past the limit until its limit-th newest leaves", () => {
    const newest = recent(LIMIT + 1);
    expect(fits(newest)).toEqual(
      new Date(newest[LIMIT - 1]!.getTime() + WINDOW_MS),
    );
  });

  it("stops counting a signup the moment the window passes it", () => {
    const newest = [...recent(LIMIT - 1), at(-WINDOW_MS)];
    expect(fits(newest)).toBeNull();
    newest[LIMIT - 1] = at(1 - WINDOW_MS);
    expect(fits(newest)).toEqual(at(1));
  });
});
