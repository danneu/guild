import { describe, expect, it, vi } from "vitest";

import { countReadableSubscriptions } from "./notifications";
import { subscribeToTopic } from "./subscriptions";
import { pool } from "./util";

vi.mock("./util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./util")>()),
  pool: { query: vi.fn(), withTransaction: vi.fn() },
}));

// What the cap counts: server/db/notifications.test.ts tests the gate.
vi.mock("./notifications", () => ({ countReadableSubscriptions: vi.fn() }));

// server/bbcode.js loads cache3 with a CommonJS require that vitest cannot
// resolve to a .ts file. Nothing tested here renders markup.
vi.mock("../bbcode", () => ({ default: vi.fn() }));

const viewer = { id: 7, role: "member" };
const topicId = 20;

// A client in a transaction where the viewer keeps `count` readable
// subscriptions
function subscriptions(count: number) {
  vi.mocked(countReadableSubscriptions).mockResolvedValue(count);
  const client = {
    _inTransaction: true,
    query: vi.fn(async () => ({ rows: [{}], rowCount: 1 })),
  } as any;
  vi.mocked(pool.withTransaction).mockImplementation(async (fn: any) =>
    fn(client),
  );
  return client;
}

function inserts(client: any): unknown[][] {
  return client.query.mock.calls
    .filter(([sql]: [string]) => /INSERT INTO topic_subscriptions/.test(sql))
    .map(([, params]: [string, unknown[]]) => params);
}

// Intent: a member keeps at most 200 subscriptions they can read, and the
// count runs in the write's transaction.
// Why it exists: hunt finding 261117-0852-031. The route counted and then
// inserted in separate queries, so a burst of subscribes all passed the cap.
describe("subscribeToTopic", () => {
  it("adds a 200th subscription", async () => {
    const client = subscriptions(199);

    await expect(subscribeToTopic(viewer, topicId)).resolves.toEqual({
      type: "SUBSCRIBED",
    });
    expect(countReadableSubscriptions).toHaveBeenCalledWith(client, viewer);
    expect(inserts(client)).toEqual([[viewer.id, topicId]]);
  });

  it("refuses a 201st subscription", async () => {
    const client = subscriptions(200);

    await expect(subscribeToTopic(viewer, topicId)).resolves.toEqual({
      type: "TOO_MANY",
    });
    expect(inserts(client)).toEqual([]);
  });
});
