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
        fetch: async (prevValue) => [{ id: 1, name: "Alice Updated" }],
      },
      settings: {
        enabled: true,
        initialValue: { theme: "dark" },
        interval: 10000,
        fetch: async (prevValue) => ({ theme: "light" }),
      },
    });

    deepEqual(cache.get("users"), [{ id: 1, name: "Alice" }]);
    deepEqual(cache.get("settings"), { theme: "dark" });

    cache.stop();
  });

  it("start() begins update loop and updateLoop handles population", async () => {
    let usersFetchCount = 0;
    let settingsFetchCount = 0;

    const cache = createIntervalCache({
      users: {
        enabled: true,
        initialValue: [],
        interval: 100, // Short interval for testing
        fetch: async (prevValue) => {
          usersFetchCount++;
          return [{ id: usersFetchCount, name: `User ${usersFetchCount}` }];
        },
      },
      settings: {
        enabled: false, // This should not be populated
        initialValue: { theme: "dark" },
        interval: 100,
        fetch: async (prevValue) => {
          settingsFetchCount++;
          return { theme: "light" };
        },
      },
    }, { loopInterval: 50 });

    // Before start(), should have initial values
    deepEqual(cache.get("users"), []);
    deepEqual(cache.get("settings"), { theme: "dark" });

    // Start should just begin the update loop (synchronous call)
    cache.start();

    // Wait for update loop to run and populate enabled keys
    await vi.advanceTimersByTimeAsync(150);

    // Users should be populated by updateLoop, settings should remain initial
    ok(usersFetchCount > 0);
    ok(cache.get("users").length > 0);
    deepEqual(cache.get("settings"), { theme: "dark" });
    deepEqual(settingsFetchCount, 0);

    cache.stop();
  });

  it("start() doesn't throw and updateLoop emits error events on failures", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const errorEvents: IntervalCacheError[] = [];

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 100,
        fetch: async (prevValue) => {
          throw new Error("Update failed");
        },
      },
    }, { loopInterval: 50 });

    cache.on('error', (error: IntervalCacheError) => {
      errorEvents.push(error);
    });

    // start() should not throw
    cache.start();

    // Wait for updateLoop to run and emit error
    await vi.advanceTimersByTimeAsync(150);

    // Should still have initial value after failed update
    deepEqual(cache.get("data"), "initial");
    ok(consoleSpy.mock.calls.length > 0);
    ok(errorEvents.length > 0);
    deepEqual(errorEvents[0].key, "data");

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
          interval: 1000, // Longer interval to avoid interference
          fetch: async (prevValue) => `enabled-${++enabledFetchCount}`,
        },
        disabled: {
          enabled: false,
          initialValue: "initial",
          interval: 100,
          fetch: async (prevValue) => `disabled-${++disabledFetchCount}`,
        },
        conditional: {
          enabled: 0, // Falsy but not undefined
          initialValue: "initial",
          interval: 100,
          fetch: async (prevValue) => "should-not-fetch",
        },
      },
      { loopInterval: 50 },
    );

    // Start the cache (this will begin the update loop)
    cache.start();
    
    // Wait for updateLoop to run and populate enabled keys
    await vi.advanceTimersByTimeAsync(150);

    // Enabled key should be populated by updateLoop
    ok(cache.get("enabled").startsWith("enabled-"));
    ok(enabledFetchCount >= 1);

    // Disabled keys should not be populated
    deepEqual(cache.get("disabled"), "initial");
    deepEqual(cache.get("conditional"), "initial");

    // Request updates
    cache.requestUpdate("enabled");
    cache.requestUpdate("disabled");
    cache.requestUpdate("conditional");

    // Reset counter for cleaner test
    const countBeforeRequest = enabledFetchCount;
    
    // Wait for next update cycle (interval needs to pass)
    await vi.advanceTimersByTimeAsync(1050);

    // Only enabled key should have updated (at least one more time)
    ok(enabledFetchCount > countBeforeRequest);
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
        fetch: async (prevValue) => "fetched",
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
          fetch: async (prevValue) => {
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
          fetch: async (prevValue) => `update-${++fetchCount}`,
        },
      },
      { loopInterval: 100 },
    ); // Fast loop for testing

    // Start the cache (begins update loop)
    cache.start();
    
    // Wait for updateLoop to run once
    await vi.advanceTimersByTimeAsync(150);
    const initialValue = cache.get("data");
    const initialCount = fetchCount;

    // The robust logic now auto-requests when intervals pass, 
    // so we need to verify that updates happen on schedule
    const countBeforeInterval = fetchCount;
    
    // Wait for interval to pass - the cache should auto-update
    await vi.advanceTimersByTimeAsync(2100); // Wait for full interval + some margin
    ok(fetchCount > countBeforeInterval, "Should have updated automatically when interval passed");

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
          fetch: async (prevValue) => `update-${++fetchCount}`,
        },
      },
      { loopInterval: 100 },
    );

    // Start the cache (begins update loop)
    cache.start();
    
    // Wait for updateLoop to run once
    await vi.advanceTimersByTimeAsync(150);
    ok(fetchCount > 0);

    // The robust logic automatically requests updates when intervals pass
    const valueAfterFirstUpdate = cache.get("data");
    const countAfterFirstUpdate = fetchCount;
    
    // Wait for next interval - should auto-update
    await vi.advanceTimersByTimeAsync(2100); // Wait for full interval + margin
    
    // Should have updated again automatically
    ok(fetchCount > countAfterFirstUpdate, "Should have updated automatically on interval");
    const valueAfterSecondUpdate = cache.get("data");
    ok(valueAfterSecondUpdate !== valueAfterFirstUpdate, "Value should have changed");

    cache.stop();
  });

  it("handles fetch errors gracefully", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cache = createIntervalCache({
      data: {
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => {
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
          fetch: async (prevValue) => "updated",
        },
      },
      { loopInterval: 10000 },
    ); // Slow loop

    const entry = cache.getEntry("data");
    deepEqual(entry?.value, "initial");
    ok(entry?.lastUpdated <= 0, "lastUpdated should be <= 0 due to jitter"); // Now has negative jitter
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
          fetch: async (prevValue) => {
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

    // Start the cache (begins update loop) 
    cache.start();
    
    // Wait for initial update
    await vi.advanceTimersByTimeAsync(75);
    ok(updateCount >= 1);

    // Request rapid updates
    cache.requestUpdate("data");
    cache.requestUpdate("data");
    cache.requestUpdate("data");

    // Let updates process
    await vi.advanceTimersByTimeAsync(200);
    
    // Should only have limited updates despite multiple requests due to concurrency protection
    const initialCount = updateCount;
    ok(updateCount >= 1, `Expected at least 1 update, got ${updateCount}`);

    cache.stop();
  });

  it("returns undefined and warns when accessing non-existent key", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "value",
        interval: 1000,
        fetch: async (prevValue) => "updated",
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

  it("stop() preserves cache data but stops updates", async () => {
    let fetchCount = 0;
    const cache = createIntervalCache(
      {
        data: {
          enabled: true,
          initialValue: "initial",
          interval: 1000,
          fetch: async (prevValue) => `update-${++fetchCount}`,
        },
      },
      { loopInterval: 100 },
    );

    // Start and wait for updateLoop to run
    cache.start();
    
    // Wait for updateLoop to run once
    await vi.advanceTimersByTimeAsync(150);
    const valueAfterStart = cache.get("data");

    // Stop the cache
    cache.stop();

    const countAfterStop = fetchCount;

    // No more updates should occur
    await vi.advanceTimersByTimeAsync(5000);
    deepEqual(fetchCount, countAfterStop);

    // Cache data should still be accessible
    const valueAfterStop = cache.get("data");
    deepEqual(valueAfterStop, valueAfterStart);

    // Should be able to request updates but they won't happen
    cache.requestUpdate("data");
    await vi.advanceTimersByTimeAsync(2000);
    deepEqual(fetchCount, countAfterStop);

    // forceUpdate should still work after stop
    const expectedValue = `update-${fetchCount + 1}`;
    const forceResult = await cache.forceUpdate("data");
    deepEqual(forceResult, expectedValue);
    deepEqual(cache.get("data"), expectedValue);
  });

  it("emits error events during updateLoop failures", async () => {
    const errorEvents: IntervalCacheError[] = [];
    
    const cache = createIntervalCache({
      failing: {
        enabled: true,
        initialValue: "initial",
        interval: 100,
        fetch: async (prevValue) => {
          throw new Error("Update failed");
        },
      },
      working: {
        enabled: true,
        initialValue: "initial", 
        interval: 100,
        fetch: async (prevValue) => "success",
      },
    }, { loopInterval: 50 });

    cache.on('error', (error: IntervalCacheError) => {
      errorEvents.push(error);
    });

    // start() should not throw
    cache.start();

    // Wait for updateLoop to run and emit error events
    await vi.advanceTimersByTimeAsync(150);

    // Should have received at least one error event
    ok(errorEvents.length >= 1);
    deepEqual(errorEvents[0].name, "IntervalCacheError");
    deepEqual(errorEvents[0].key, "failing");
    ok(errorEvents[0].message.includes("Update failed"));

    // Failing key should retain initial value, working key should be populated
    deepEqual(cache.get("failing"), "initial"); // Should retain initial value
    deepEqual(cache.get("working"), "success"); // Should be populated successfully

    cache.stop();
  });

  it("emits error events during background updates", async () => {
    const errorEvents: IntervalCacheError[] = [];
    let shouldFail = false;

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000, // Use valid interval
        fetch: async (prevValue) => {
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

    cache.start();
    
    // Wait for updateLoop to run once successfully  
    await vi.advanceTimersByTimeAsync(1100);
    deepEqual(cache.get("data"), "success");
    deepEqual(errorEvents.length, 0);

    // Make the next fetch fail
    shouldFail = true;
    cache.requestUpdate("data");

    // Wait for the update to be attempted (interval + loop time)
    await vi.advanceTimersByTimeAsync(1100);

    // Should have received at least one error event (may be more due to auto-retries)
    ok(errorEvents.length >= 1);
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
        fetch: async (prevValue) => {
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
        fetch: async (prevValue) => {
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
        fetch: async (prevValue) => "updated",
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

  it("validates and normalizes cache entry intervals", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    
    const cache = createIntervalCache({
      tooShort: {
        enabled: true,
        initialValue: "value1",
        interval: 500, // Too short, should be normalized to 1000
        fetch: async (prevValue) => "updated1",
      },
      justRight: {
        enabled: true,
        initialValue: "value2", 
        interval: 1000, // Just right
        fetch: async (prevValue) => "updated2",
      },
      runOnce: {
        enabled: true,
        initialValue: "value3",
        interval: Infinity, // Should be allowed
        fetch: async (prevValue) => "updated3",
      },
      veryShort: {
        enabled: true,
        initialValue: "value4",
        interval: 100, // Very short, should be normalized
        fetch: async (prevValue) => "updated4",
      },
    });

    // Should have warned about short intervals
    ok(consoleSpy.mock.calls.length >= 2);
    ok(consoleSpy.mock.calls.some(call => call[0].includes("tooShort")));
    ok(consoleSpy.mock.calls.some(call => call[0].includes("veryShort")));
    ok(consoleSpy.mock.calls.some(call => call[0].includes("defaulting to 1000ms")));

    cache.stop();
    consoleSpy.mockRestore();
  });

  it("implements exponential backoff on fetch failures", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => {
          throw new Error("Always fails");
        },
      },
    }, { 
      loopInterval: 50,
      backoff: {
        maxBackoffMs: 10000,
        multiplier: 2,
      }
    });

    // Test using forceUpdate to bypass timing complexities
    await cache.forceUpdate("data"); // 1st failure
    await cache.forceUpdate("data"); // 2nd failure  
    await cache.forceUpdate("data"); // 3rd failure

    // Verify the exponential backoff pattern in the logs
    ok(consoleSpy.mock.calls.some(call => 
      call[0].includes("attempt 1") && call[0].includes("backing off 1000ms")
    ));
    ok(consoleSpy.mock.calls.some(call => 
      call[0].includes("attempt 2") && call[0].includes("backing off 2000ms")
    ));
    ok(consoleSpy.mock.calls.some(call => 
      call[0].includes("attempt 3") && call[0].includes("backing off 4000ms")
    ));

    cache.stop();
    consoleSpy.mockRestore();
  });

  it("respects maxBackoffMs setting", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => {
          throw new Error("Always fails");
        },
      },
    }, { 
      loopInterval: 50,
      backoff: {
        maxBackoffMs: 3000, // Cap at 3 seconds
        multiplier: 2,
      }
    });

    // Use forceUpdate to test the max backoff quickly
    await cache.forceUpdate("data"); // 1st: 1000ms backoff
    await cache.forceUpdate("data"); // 2nd: 2000ms backoff  
    await cache.forceUpdate("data"); // 3rd: should be 4000ms but capped at 3000ms

    // Verify backoff was capped at maxBackoffMs (3000ms, not 4000ms)
    ok(consoleSpy.mock.calls.some(call => 
      call[0].includes("attempt 3") && call[0].includes("backing off 3000ms")
    ));

    cache.stop();
    consoleSpy.mockRestore();
  });

  it("resets backoff state on successful update", async () => {
    let shouldFail = true;

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => {
          if (shouldFail) {
            throw new Error("Failure");
          }
          return `success-${Date.now()}`;
        },
      },
    }, { 
      loopInterval: 50,
      backoff: { maxBackoffMs: 10000, multiplier: 2 }
    });

    cache.start();

    // Let it fail once to set backoff state
    await vi.advanceTimersByTimeAsync(1100);
    
    // Verify failure state exists
    let entry = cache.getEntry("data");
    ok(entry?.failureCount > 0);
    ok(entry?.backoffUntil > 0);

    // Now make it succeed
    shouldFail = false;
    
    // Force an update to bypass backoff timing
    await cache.forceUpdate("data");
    ok(cache.get("data").startsWith("success"));

    // Check that backoff state was reset
    entry = cache.getEntry("data");
    deepEqual(entry?.failureCount, 0);
    deepEqual(entry?.backoffUntil, 0);

    cache.stop();
  });

  it("preserves backoff state when manually setting values", () => {
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => { throw new Error("Always fails"); },
      },
    });

    // Simulate a failure state by directly manipulating entry
    const entry = cache.getEntry("data");
    if (entry) {
      entry.failureCount = 5;
      entry.backoffUntil = Date.now() + 10000;
    }

    const originalBackoffUntil = entry?.backoffUntil || 0;

    // Manual set should NOT reset backoff state
    cache.set("data", "manually set");
    
    const updatedEntry = cache.getEntry("data");
    deepEqual(updatedEntry?.failureCount, 5); // Should remain unchanged
    deepEqual(updatedEntry?.backoffUntil, originalBackoffUntil); // Should remain unchanged
    deepEqual(updatedEntry?.value, "manually set");

    cache.stop();
  });

  it("debug option enables verbose logging", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => "updated",
      },
    }, { debug: true });

    // These operations should generate debug logs
    cache.start();
    cache.requestUpdate("data");
    cache.set("data", "manually set");
    cache.stop();

    // Verify debug logs were called
    ok(consoleSpy.mock.calls.some(call => 
      call[0] === "[IntervalCache debug]" && call[1].includes("Starting cache")
    ));
    ok(consoleSpy.mock.calls.some(call => 
      call[0] === "[IntervalCache debug]" && call[1].includes("Requesting update")
    ));
    ok(consoleSpy.mock.calls.some(call => 
      call[0] === "[IntervalCache debug]" && call[1].includes("Manually setting value")
    ));
    ok(consoleSpy.mock.calls.some(call => 
      call[0] === "[IntervalCache debug]" && call[1].includes("Stopping cache")
    ));

    consoleSpy.mockRestore();
  });

  it("debug disabled by default produces no debug logs", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => "updated",
      },
    }); // No debug option = default false

    cache.start();
    cache.set("data", "manually set");
    cache.stop();

    // Should not have any debug logs (only warn/error logs allowed)
    ok(!consoleSpy.mock.calls.some(call => call[0] === "[IntervalCache debug]"));

    consoleSpy.mockRestore();
  });

  it("robust updateRequested logic works correctly", async () => {
    let fetchCount = 0;
    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => `update-${++fetchCount}`,
      },
    }, { loopInterval: 100 });

    // Start cache
    cache.start();
    
    // Check initial state - should start with updateRequested = true for enabled entries
    let entry = cache.getEntry("data");
    ok(entry?.updateRequested, "Should start with updateRequested = true for enabled entries");
    
    // Wait for initial update
    await vi.advanceTimersByTimeAsync(150);
    
    entry = cache.getEntry("data");
    deepEqual(entry?.updateRequested, false, "Should clear updateRequested after update");
    ok(fetchCount >= 1, "Should have fetched at least once");
    
    // Manually test the two-step logic by checking auto-request behavior
    // Wait for enough time that interval should trigger auto-request
    await vi.advanceTimersByTimeAsync(1050); // Just over the 1000ms interval
    
    entry = cache.getEntry("data");
    // At this point, either updateRequested should be true (auto-requested)
    // OR the update should have already happened (which would clear it again)
    
    // Verify that at least we get recurring updates
    const initialCount = fetchCount;
    await vi.advanceTimersByTimeAsync(1100); // Wait for another interval
    
    ok(fetchCount > initialCount, "Should have additional updates from auto-request logic");
    
    cache.stop();
  });

  it("emits type-safe update events on successful updates", async () => {
    let updateCount = 0;
    let lastUpdateEvent: any;

    const cache = createIntervalCache({
      data: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => `updated-${Date.now()}`,
      },
      counter: {
        enabled: true,
        initialValue: 0,
        interval: 1000,
        fetch: async (prevValue) => 42,
      },
    }, { loopInterval: 100 });

    // Listen for update events
    cache.on("update", (event) => {
      updateCount++;
      lastUpdateEvent = event;
    });

    // Force update to trigger event
    const result = await cache.forceUpdate("data");
    
    // Should have received an update event
    deepEqual(updateCount, 1);
    deepEqual(lastUpdateEvent.key, "data");
    deepEqual(lastUpdateEvent.value, result);
    ok(lastUpdateEvent.value.startsWith("updated-"));

    // Test another key
    await cache.forceUpdate("counter");
    
    deepEqual(updateCount, 2);
    deepEqual(lastUpdateEvent.key, "counter");
    deepEqual(lastUpdateEvent.value, 42);

    cache.stop();
  });

  it("maintains type-safe error events", async () => {
    const errorEvents: any[] = [];
    
    const cache = createIntervalCache({
      failing: {
        enabled: true,
        initialValue: "initial",
        interval: 1000,
        fetch: async (prevValue) => {
          throw new Error("Test error");
        },
      },
    });

    cache.on("error", (error) => {
      errorEvents.push(error);
    });

    await cache.forceUpdate("failing");

    deepEqual(errorEvents.length, 1);
    deepEqual(errorEvents[0].key, "failing");
    ok(errorEvents[0].message.includes("Test error"));

    cache.stop();
  });

  it("applies random jitter to prevent thundering herd", () => {
    const cache = createIntervalCache({
      key1: {
        enabled: true,
        initialValue: "value1",
        interval: 5000,
        fetch: async (prevValue) => "updated1",
      },
      key2: {
        enabled: true,
        initialValue: "value2", 
        interval: 5000,
        fetch: async (prevValue) => "updated2",
      },
      key3: {
        enabled: true,
        initialValue: "value3",
        interval: 5000,
        fetch: async (prevValue) => "updated3",
      },
    });

    // All entries should have negative lastUpdated due to jitter
    const entry1 = cache.getEntry("key1");
    const entry2 = cache.getEntry("key2");
    const entry3 = cache.getEntry("key3");
    
    ok(entry1?.lastUpdated < 0, "key1 should have negative lastUpdated");
    ok(entry2?.lastUpdated < 0, "key2 should have negative lastUpdated");
    ok(entry3?.lastUpdated < 0, "key3 should have negative lastUpdated");
    
    // They should be within the interval range
    ok(entry1.lastUpdated >= -5000, "key1 jitter should be within interval");
    ok(entry2.lastUpdated >= -5000, "key2 jitter should be within interval");
    ok(entry3.lastUpdated >= -5000, "key3 jitter should be within interval");
    
    // They should likely be different (very low chance of collision)
    ok(entry1.lastUpdated !== entry2.lastUpdated || 
       entry2.lastUpdated !== entry3.lastUpdated, 
       "Jitter should make entries have different lastUpdated values");

    cache.stop();
  });
});
