import { describe, it, beforeEach, afterEach, vi } from "vitest";
import { deepEqual, ok } from "node:assert";
import { createIntervalCache, IntervalCacheError } from "./index";

describe("createIntervalCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes with provided initial values", () => {
    const cache = createIntervalCache({
      users: {
        enabled: true,
        initialValue: [{ id: 1, name: "Alice" }],
        interval: 5000,
        fetch: async () => [{ id: 1, name: "Alice Updated" }],
      },
      settings: {
        enabled: true,
        initialValue: { theme: "dark" },
        interval: 10000,
        fetch: async () => ({ theme: "light" }),
      },
    });

    deepEqual(cache.get("users"), [{ id: 1, name: "Alice" }]);
    deepEqual(cache.get("settings"), { theme: "dark" });

    cache.stop();
  });

  it("start() populates all enabled keys before starting intervals", async () => {
    let usersFetchCount = 0;
    let settingsFetchCount = 0;

    const cache = createIntervalCache({
      users: {
        enabled: true,
        initialValue: [],
        interval: 5000,
        fetch: async () => {
          usersFetchCount++;
          return [{ id: usersFetchCount, name: `User ${usersFetchCount}` }];
        },
      },
      settings: {
        enabled: false, // This should not be populated
        initialValue: { theme: "dark" },
        interval: 10000,
        fetch: async () => {
          settingsFetchCount++;
          return { theme: "light" };
        },
      },
    });

    // Before start(), should have initial values
    deepEqual(cache.get("users"), []);
    deepEqual(cache.get("settings"), { theme: "dark" });

    // Start should populate enabled keys
    await cache.start();

    // Users should be populated, settings should remain initial
    deepEqual(cache.get("users"), [{ id: 1, name: "User 1" }]);
    deepEqual(cache.get("settings"), { theme: "dark" });
    deepEqual(usersFetchCount, 1);
    deepEqual(settingsFetchCount, 0);

    cache.stop();
  });

  it("start() throws when population fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async () => {
          throw new Error("Population failed");
        },
      },
    });

    try {
      await cache.start();
      throw new Error("Should have thrown");
    } catch (error: any) {
      ok(error.message.includes("Failed to populate cache entries"));
    }

    // Should still have initial value after failed population
    deepEqual(cache.get("data"), "initial");
    ok(consoleSpy.mock.calls.length > 0);

    cache.stop();
    consoleSpy.mockRestore();
  });

  it("respects enabled flag", async () => {
    let enabledFetchCount = 0;
    let disabledFetchCount = 0;

    const cache = createIntervalCache(
      {
        enabled: {
          enabled: true,
          initialValue: "initial",
          interval: 100,
          fetch: async () => `enabled-${++enabledFetchCount}`,
        },
        disabled: {
          enabled: false,
          initialValue: "initial",
          interval: 100,
          fetch: async () => `disabled-${++disabledFetchCount}`,
        },
        conditional: {
          enabled: 0, // Falsy but not undefined
          initialValue: "initial",
          interval: 100,
          fetch: async () => "should-not-fetch",
        },
      },
      { loopInterval: 50 },
    );

    // Start the cache (this will populate enabled keys)
    await cache.start();

    // Enabled key should be populated
    deepEqual(cache.get("enabled"), "enabled-1");

    // Disabled keys should not be populated
    deepEqual(cache.get("disabled"), "initial");
    deepEqual(cache.get("conditional"), "initial");

    // Request updates
    cache.requestUpdate("enabled");
    cache.requestUpdate("disabled");
    cache.requestUpdate("conditional");

    // Wait for next update cycle
    await vi.advanceTimersByTimeAsync(150);

    // Only enabled key should have updated
    deepEqual(cache.get("enabled"), "enabled-2");
    deepEqual(cache.get("disabled"), "initial");
    deepEqual(cache.get("conditional"), "initial");
    deepEqual(disabledFetchCount, 0);

    cache.stop();
  });

  it("set() updates value immediately", () => {
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 5000,
        fetch: async () => "fetched",
      },
    });

    const entry = cache.getEntry("data");
    const initialTime = entry?.lastUpdated || 0;

    // Set new value
    cache.set("data", "manually set");

    // Value should be updated immediately
    deepEqual(cache.get("data"), "manually set");

    // Entry should be updated
    const updatedEntry = cache.getEntry("data");
    ok(updatedEntry);
    deepEqual(updatedEntry.value, "manually set");
    ok(updatedEntry.lastUpdated > initialTime);
    deepEqual(updatedEntry.updateRequested, false); // Should clear any pending requests

    cache.stop();
  });

  it("forceUpdate() updates immediately and returns the fetched value", async () => {
    let fetchCount = 0;
    const cache = createIntervalCache(
      {
        counter: {
          enabled: true,
          initialValue: 0,
          interval: 5000,
          fetch: async () => {
            fetchCount++;
            return fetchCount;
          },
        },
      },
      10000,
    ); // Very slow loop to prevent automatic updates

    // Force update immediately
    const result1 = await cache.forceUpdate("counter");
    deepEqual(result1, 1);
    deepEqual(cache.get("counter"), 1);

    // Another forced update
    const result2 = await cache.forceUpdate("counter");
    deepEqual(result2, 2);
    deepEqual(cache.get("counter"), 2);

    cache.stop();
  });

  it("requestUpdate() respects interval timing", async () => {
    let fetchCount = 0;
    const cache = createIntervalCache(
      {
        data: {
          enabled: true,
          initialValue: "initial",
          interval: 2000,
          fetch: async () => `update-${++fetchCount}`,
        },
      },
      { loopInterval: 100 },
    ); // Fast loop for testing

    // Start the cache (populates initially)
    await cache.start();
    deepEqual(cache.get("data"), "update-1");

    // Request update immediately after - should not update (interval not passed)
    cache.requestUpdate("data");
    await vi.advanceTimersByTimeAsync(100);
    deepEqual(cache.get("data"), "update-1");

    // Wait for interval to pass, then it should update
    await vi.advanceTimersByTimeAsync(1900);
    deepEqual(cache.get("data"), "update-2");

    cache.stop();
  });


  it("automatic updates happen based on interval", async () => {
    let fetchCount = 0;
    const cache = createIntervalCache(
      {
        data: {
          enabled: true,
          initialValue: "initial",
          interval: 2000,
          fetch: async () => `update-${++fetchCount}`,
        },
      },
      { loopInterval: 100 },
    );

    // Start the cache (populates initially)
    await cache.start();
    deepEqual(cache.get("data"), "update-1");

    // Request another update
    cache.requestUpdate("data");

    // Should not update before interval
    await vi.advanceTimersByTimeAsync(1000);
    deepEqual(cache.get("data"), "update-1");

    // Should update after interval (2000ms total)
    await vi.advanceTimersByTimeAsync(1100);
    deepEqual(cache.get("data"), "update-2");

    cache.stop();
  });

  it("handles fetch errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cache = createIntervalCache({
      data: {
        initialValue: "initial",
        interval: 1000,
        fetch: async () => {
          throw new Error("Fetch failed");
        },
      },
    });

    await cache.forceUpdate("data");
    deepEqual(cache.get("data"), "initial"); // Value unchanged
    ok(consoleSpy.mock.calls.length > 0);

    cache.stop();
    consoleSpy.mockRestore();
  });

  it("getEntry() exposes cache metadata", async () => {
    const cache = createIntervalCache(
      {
        data: {
          enabled: true,
          initialValue: "initial",
          interval: 5000,
          fetch: async () => "updated",
        },
      },
      { loopInterval: 10000 },
    ); // Slow loop

    const entry = cache.getEntry("data");
    deepEqual(entry?.value, "initial");
    deepEqual(entry?.lastUpdated, 0);
    deepEqual(entry?.updateRequested, true);
    deepEqual(entry?.updating, false);

    await cache.forceUpdate("data");

    const updatedEntry = cache.getEntry("data");
    ok(updatedEntry);
    deepEqual(updatedEntry.value, "updated");
    ok(updatedEntry.lastUpdated > 0);
    deepEqual(updatedEntry.updateRequested, false);

    cache.stop();
  });

  it("prevents concurrent updates", async () => {
    let activeUpdates = 0;
    let updateCount = 0;

    const cache = createIntervalCache(
      {
        data: {
          enabled: true,
          initialValue: "initial",
          interval: 100,
          fetch: async () => {
            activeUpdates++;
            ok(activeUpdates <= 1, "Multiple updates running concurrently");
            // Use vi.waitFor instead of raw setTimeout to work better with fake timers
            await vi.waitFor(() => true, { timeout: 50 });
            activeUpdates--;
            return `update-${++updateCount}`;
          },
        },
      },
      { loopInterval: 25 },
    ); // Very fast loop

    // Start the cache (populates initially) 
    await cache.start();
    deepEqual(updateCount, 1);

    // Request rapid updates
    cache.requestUpdate("data");
    cache.requestUpdate("data");
    cache.requestUpdate("data");

    // Let updates process
    await vi.advanceTimersByTimeAsync(200);
    
    // Should only have one additional update despite multiple requests
    ok(updateCount <= 2, `Expected at most 2 updates, got ${updateCount}`);

    cache.stop();
  });

  it("returns undefined and warns when accessing non-existent key", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "value",
        interval: 1000,
        fetch: async () => "updated",
      },
    });

    // @ts-expect-error - Testing invalid key
    const result = cache.get("nonexistent");
    deepEqual(result, undefined);
    ok(consoleSpy.mock.calls.length > 0);
    ok(consoleSpy.mock.calls[0][0].includes("Cache key 'nonexistent' not found"));

    try {
      // @ts-expect-error - Testing invalid key
      cache.requestUpdate("nonexistent");
      throw new Error("Should have thrown");
    } catch (error: any) {
      deepEqual(error.message, "Cache key 'nonexistent' not found");
    }

    cache.stop();
    consoleSpy.mockRestore();
  });

  it("stop() clears cache and stops updates", async () => {
    let fetchCount = 0;
    const cache = createIntervalCache(
      {
        data: {
          enabled: true,
          initialValue: "initial",
          interval: 1000,
          fetch: async () => `update-${++fetchCount}`,
        },
      },
      { loopInterval: 100 },
    );

    // Start and initial update
    await cache.start();
    ok(fetchCount > 0);

    // Stop the cache
    cache.stop();

    const countAfterStop = fetchCount;

    // No more updates should occur
    await vi.advanceTimersByTimeAsync(5000);
    deepEqual(fetchCount, countAfterStop);

    // Cache should be cleared - get() should return undefined and warn
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = cache.get("data");
    deepEqual(result, undefined);
    ok(consoleSpy.mock.calls.length > 0);
    consoleSpy.mockRestore();
  });

  it("emits error events during start() population failures", async () => {
    const errorEvents: IntervalCacheError[] = [];
    
    const cache = createIntervalCache({
      failing: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async () => {
          throw new Error("Population failed");
        },
      },
      working: {
        enabled: true,
        initialValue: "initial", 
        interval: 1000,
        fetch: async () => "success",
      },
    });

    cache.on('error', (error: IntervalCacheError) => {
      errorEvents.push(error);
    });

    try {
      await cache.start();
      throw new Error("Should have thrown");
    } catch (error: any) {
      ok(error.message.includes("Failed to populate cache entries"));
    }

    // Should have received one error event
    deepEqual(errorEvents.length, 1);
    deepEqual(errorEvents[0].name, "IntervalCacheError");
    deepEqual(errorEvents[0].key, "failing");
    ok(errorEvents[0].message.includes("Population failed"));

    // Failing key should retain initial value, working key may have succeeded before failure
    deepEqual(cache.get("failing"), "initial"); // Should retain initial value
    // Working key might be populated if it completed before the failure occurred

    cache.stop();
  });

  it("emits error events during background updates", async () => {
    const errorEvents: IntervalCacheError[] = [];
    let shouldFail = false;

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 100,
        fetch: async () => {
          if (shouldFail) {
            throw new Error("Update failed");
          }
          return "success";
        },
      },
    }, { loopInterval: 50 });

    cache.on('error', (error: IntervalCacheError) => {
      errorEvents.push(error);
    });

    await cache.start();
    deepEqual(cache.get("data"), "success");
    deepEqual(errorEvents.length, 0);

    // Make the next fetch fail
    shouldFail = true;
    cache.requestUpdate("data");

    // Wait for the update to be attempted
    await vi.advanceTimersByTimeAsync(150);

    // Should have received an error event
    deepEqual(errorEvents.length, 1);
    deepEqual(errorEvents[0].name, "IntervalCacheError");
    deepEqual(errorEvents[0].key, "data");
    ok(errorEvents[0].message.includes("Update failed"));

    // Value should remain unchanged after error
    deepEqual(cache.get("data"), "success");

    cache.stop();
  });

  it("emits error events during forceUpdate failures and returns undefined", async () => {
    const errorEvents: IntervalCacheError[] = [];

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async () => {
          throw new Error("Force update failed");
        },
      },
    });

    cache.on('error', (error: IntervalCacheError) => {
      errorEvents.push(error);
    });

    const result = await cache.forceUpdate("data");

    // Should return undefined on error
    deepEqual(result, undefined);

    // Should have received one error event
    deepEqual(errorEvents.length, 1);
    deepEqual(errorEvents[0].name, "IntervalCacheError");
    deepEqual(errorEvents[0].key, "data");
    ok(errorEvents[0].message.includes("Force update failed"));

    // Value should remain unchanged
    deepEqual(cache.get("data"), "initial");

    cache.stop();
  });

  it("error events include original error as cause", async () => {
    const errorEvents: IntervalCacheError[] = [];
    const originalError = new Error("Original error message");

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async () => {
          throw originalError;
        },
      },
    });

    cache.on('error', (error: IntervalCacheError) => {
      errorEvents.push(error);
    });

    const result = await cache.forceUpdate("data");

    deepEqual(result, undefined);
    deepEqual(errorEvents.length, 1);
    deepEqual(errorEvents[0].cause, originalError);

    cache.stop();
  });

  it("forceUpdate() warns and returns undefined for non-existent keys", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "value",
        interval: 1000,
        fetch: async () => "updated",
      },
    });

    // @ts-expect-error - Testing invalid key
    const result = await cache.forceUpdate("nonexistent");
    
    deepEqual(result, undefined);
    ok(consoleSpy.mock.calls.length > 0);
    ok(consoleSpy.mock.calls[0][0].includes("Cache key 'nonexistent' not found"));

    cache.stop();
    consoleSpy.mockRestore();
  });
});
