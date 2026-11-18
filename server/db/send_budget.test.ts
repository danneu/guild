import { beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "../config";
import { createConvo, createPm, createStatus, createVm } from "./index";
import {
  lockStanding,
  SendBudgetExceeded,
  spend,
  whenItFits,
} from "./send_budget";
import { VmParentRefused } from "./vms";

// Mutable so one test can unset the staff account the way an unset env var
// does (config parses it to NaN).
const staff = vi.hoisted(() => ({ id: 8231 }));
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  get STAFF_REPRESENTATIVE_ID() {
    return staff.id;
  },
}));

// server/bbcode.js loads ./cache3 with a plain require, which cannot load
// TypeScript under vitest.
vi.mock("../bbcode", () => ({ default: (markup: string) => markup }));

const HOUR = 60 * 60 * 1000;
const UNTRUSTED = config.SEND_BUDGET_PER_HOUR_UNTRUSTED;

////////////////////////////////////////////////////////////
// A pg client stub that answers each query the way Postgres would for a send.
// server/db/time_windows.test.ts runs spend's SQL on real rows.

// The sender's users row, with the standing server/trust.ts#readTrust would
// read for them. server/trust.test.ts runs that rule on real rows.
type Sender = { posts_count: number; trusted: boolean; demoted: boolean };
// A vms row as a reply's parent lookup reads it.
type Vm = { id: number; to_user_id: number; parent_vm_id: number | null };

function makePgClient(
  opts: { sender?: Sender; spent?: number; vms?: Vm[] } = {},
) {
  const sender = opts.sender ?? {
    posts_count: 0,
    trusted: false,
    demoted: false,
  };
  const spent = opts.spent ?? 0;
  const vms = opts.vms ?? [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const rows = (() => {
      if (/FROM users/.test(sql)) return [{ id: 1, uname: "alice", ...sender }];
      if (/FROM vms/.test(sql)) return vms.filter((vm) => vm.id === params![0]);
      if (/SELECT cost, created_at/.test(sql)) {
        return spent > 0 ? [{ cost: spent, created_at: new Date() }] : [];
      }
      if (/INSERT INTO convos \(/.test(sql)) {
        return [{ id: 99, title: "Hi", pms_count: 0 }];
      }
      if (/INSERT INTO (pms|vms|statuses)/.test(sql)) return [{ id: 1 }];
      return [];
    })();
    return { rows, rowCount: rows.length };
  });
  return { _inTransaction: true as const, query } as any;
}

function sqlOf(pgClient: any): string[] {
  return pgClient.query.mock.calls.map(([sql]: [string]) => sql);
}

function spendInserts(pgClient: any): unknown[][] {
  return pgClient.query.mock.calls
    .filter(([sql]: [string]) => /INSERT INTO send_spends/.test(sql))
    .map(([, params]: [string, unknown[]]) => params);
}

function indexOfSql(pgClient: any, pattern: RegExp): number {
  return sqlOf(pgClient).findIndex((sql) => pattern.test(sql));
}

beforeEach(() => {
  staff.id = 8231;
});

////////////////////////////////////////////////////////////

describe("whenItFits", () => {
  const t0 = new Date("2026-10-26T10:00:00Z");
  const t1 = new Date("2026-10-26T10:10:00Z");
  const t2 = new Date("2026-10-26T10:20:00Z");

  it("fits now when the cost lands exactly on the budget", () => {
    expect(whenItFits([{ cost: 20, created_at: t0 }], 10, 30)).toBeNull();
  });

  it("waits until enough of the oldest spends leave the window", () => {
    const spends = [
      { cost: 5, created_at: t0 },
      { cost: 20, created_at: t1 },
      { cost: 5, created_at: t2 },
    ];

    // Dropping the 5 at t0 still leaves 25 + 10 over 30; dropping t1 fits.
    expect(whenItFits(spends, 10, 30)).toEqual(new Date(t1.getTime() + HOUR));
  });

  it("rejects a cost no window could ever fit", () => {
    expect(() => whenItFits([], 31, 30)).toThrow(/never fit/);
  });
});

describe("lockStanding", () => {
  // The rule's reads come after the lock, so a write the actor finished
  // before this one is counted.
  it("locks the actor before reading them", async () => {
    const pgClient = makePgClient();

    await lockStanding(pgClient, 1);

    const reads = sqlOf(pgClient);
    expect(reads[0]).toMatch(/pg_advisory_xact_lock/);
    expect(reads.slice(1)).toEqual([
      expect.stringMatching(/FROM users/),
      expect.stringMatching(/AS trusted/),
    ]);
  });
});

describe("spend", () => {
  it("refuses past the budget and records nothing", async () => {
    const pgClient = makePgClient({ spent: UNTRUSTED });

    await expect(spend(pgClient, 1, 1)).rejects.toBeInstanceOf(
      SendBudgetExceeded,
    );

    expect(spendInserts(pgClient)).toEqual([]);
  });

  it("gives trusted senders the larger budget", async () => {
    const pgClient = makePgClient({
      sender: { posts_count: 6, trusted: true, demoted: false },
      spent: UNTRUSTED,
    });

    await spend(pgClient, 1, 1);

    expect(spendInserts(pgClient)).toEqual([[1, 1]]);
  });

  // Two sends by one sender at once must not both read the old total.
  it("serializes the sender before reading their spends", async () => {
    const pgClient = makePgClient();

    await spend(pgClient, 1, 1);

    expect(sqlOf(pgClient)[0]).toMatch(/pg_advisory_xact_lock/);
    expect(pgClient.query.mock.calls[0][1]).toContain(1);
  });
});

////////////////////////////////////////////////////////////

describe("send writes", () => {
  const text = { markup: "hi", html: "hi" };
  const sends = [
    {
      name: "createConvo",
      insert: /INSERT INTO convos \(/,
      run: (c: any) =>
        createConvo(c, {
          sender: { kind: "member", userId: 1 },
          toUserIds: [2, 3, 3, 1],
          title: "Hi",
          ipAddress: "1.2.3.4",
          ...text,
        }),
      // Bob and Carol: the duplicate and the sender are not charged.
      cost: 2,
    },
    {
      name: "createPm",
      insert: /INSERT INTO pms/,
      run: (c: any) =>
        createPm(c, { userId: 1, ipAddress: "1.2.3.4", convoId: 99, ...text }),
      cost: 1,
    },
    {
      name: "createVm",
      insert: /INSERT INTO vms/,
      run: (c: any) =>
        createVm(c, {
          from_user_id: 1,
          to_user_id: 2,
          parent_vm_id: null,
          ...text,
        }),
      cost: 1,
    },
    {
      name: "createStatus",
      insert: /INSERT INTO statuses/,
      run: (c: any) => createStatus(c, { user_id: 1, text: "hi", html: "hi" }),
      cost: 1,
    },
  ];

  for (const send of sends) {
    it(`${send.name} pays ${send.cost} before it inserts`, async () => {
      const pgClient = makePgClient();

      await send.run(pgClient);

      expect(spendInserts(pgClient)).toEqual([[1, send.cost]]);
      expect(indexOfSql(pgClient, /INSERT INTO send_spends/)).toBeLessThan(
        indexOfSql(pgClient, send.insert),
      );
    });

    it(`${send.name} writes nothing past the budget`, async () => {
      const pgClient = makePgClient({ spent: UNTRUSTED });

      await expect(send.run(pgClient)).rejects.toBeInstanceOf(
        SendBudgetExceeded,
      );

      expect(indexOfSql(pgClient, send.insert)).toBe(-1);
    });
  }

  it("charges a self-convo 1", async () => {
    const pgClient = makePgClient();

    await createConvo(pgClient, {
      sender: { kind: "member", userId: 1 },
      toUserIds: [],
      title: "Notes",
      ipAddress: "1.2.3.4",
      ...text,
    });

    expect(spendInserts(pgClient)).toEqual([[1, 1]]);
  });

  it("sends the welcome PM as the staff account without paying", async () => {
    const pgClient = makePgClient();

    await createConvo(pgClient, {
      sender: { kind: "staff" },
      toUserIds: [2],
      title: "Welcome",
      ipAddress: "1.2.3.4",
      ...text,
    });

    expect(indexOfSql(pgClient, /send_spends|pg_advisory/)).toBe(-1);
    const insert = pgClient.query.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO convos \(/.test(sql),
    );
    expect(insert[1]).toEqual([8231, "Welcome"]);
  });

  it("refuses a staff convo when no staff account is configured", async () => {
    staff.id = NaN;
    const pgClient = makePgClient();

    await expect(
      createConvo(pgClient, {
        sender: { kind: "staff" },
        toUserIds: [2],
        title: "Welcome",
        ipAddress: "1.2.3.4",
        ...text,
      }),
    ).rejects.toThrow(/Invalid convo sender/);
    expect(indexOfSql(pgClient, /INSERT/)).toBe(-1);
  });
});

describe("createVm replies", () => {
  // Bob's wall (user 2) holds thread 10 and its reply 11. Carol's wall (user
  // 3) holds thread 20.
  const vms = [
    { id: 10, to_user_id: 2, parent_vm_id: null },
    { id: 11, to_user_id: 2, parent_vm_id: 10 },
    { id: 20, to_user_id: 3, parent_vm_id: null },
  ];

  // Alice replies on Bob's wall.
  function reply(pgClient: any, parentVmId: number) {
    return createVm(pgClient, {
      from_user_id: 1,
      to_user_id: 2,
      parent_vm_id: parentVmId,
      markup: "hi",
      html: "hi",
    });
  }

  // Intent: a reply saves only under a top-level VM on the wall it is posted
  // to, and a refused reply costs its sender nothing.
  // Why it exists: createVm saved any parent_vm_id, so a member could post a
  // reply to one wall that showed in a thread on another, where that wall's
  // owner could not delete it (hunt 261117-0852-040).
  // Scenario: Alice posts to Bob's wall under Carol's thread, under a reply,
  // and under a VM that does not exist.
  it.each([
    ["a thread on another wall", 20],
    ["a reply", 11],
    ["a missing VM", 99],
  ])("refuses a reply under %s and writes nothing", async (_label, parent) => {
    const pgClient = makePgClient({ vms });

    await expect(reply(pgClient, parent)).rejects.toBeInstanceOf(
      VmParentRefused,
    );

    // No VM, no budget read or charge, and no lock on the sender.
    expect(
      indexOfSql(pgClient, /INSERT INTO vms|send_spends|pg_advisory/),
    ).toBe(-1);
  });

  it("saves a reply under a thread on its own wall", async () => {
    const pgClient = makePgClient({ vms });

    await reply(pgClient, 10);

    expect(spendInserts(pgClient)).toEqual([[1, 1]]);
    const insert = pgClient.query.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO vms/.test(sql),
    );
    expect(insert[1]).toEqual([1, 2, "hi", "hi", 10]);
  });
});
