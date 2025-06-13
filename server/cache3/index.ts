import { EventEmitter } from "events";

export class IntervalCacheError extends Error {
  public key?: string;
  public override cause?: unknown;

  constructor(message: string, key?: string) {
    super(message);
    this.name = "IntervalCacheError";
    if (key) {
      this.key = key;
    }
  }
}

type CacheConfig<T> = {
  enabled: boolean;
  initialValue: T;
  interval: number;
  fetch: () => Promise<T>;
};

type CacheConfigMap<T extends Record<string, { value: any }>> = {
  [K in keyof T]: CacheConfig<T[K]["value"]>;
};

type CacheEntry<T> = {
  value: T;
  lastUpdated: number;
  updateRequested: boolean;
  updating: boolean;
};

export type CacheOptions = {
  loopInterval?: number;
};

const defaultOptions: CacheOptions = {
  loopInterval: 1000,
};

export function createIntervalCache<T extends Record<string, { value: any }>>(
  config: CacheConfigMap<T>,
  options: CacheOptions = defaultOptions,
) {
  const { loopInterval = defaultOptions.loopInterval } = options;
  const cache = new Map<keyof T, CacheEntry<any>>();
  let running = false; // Don't start running until start() is called
  let intervalId: NodeJS.Timeout | null = null;
  const emitter = new EventEmitter();
  // Prevent throwing errors when no listeners are attached
  emitter.on("error", () => {});

  // Initialize cache with all keys
  for (const [key, keyConfig] of Object.entries(config) as Array<
    [keyof T, CacheConfig<any>]
  >) {
    cache.set(key, {
      value: keyConfig.initialValue,
      lastUpdated: 0,
      updateRequested: keyConfig.enabled, // Only request if enabled
      updating: false,
    });
  }

  /**
   * Main background update loop that runs on the specified interval.
   * Checks each enabled cache entry to see if it needs updating based on:
   * - Whether an update was requested via requestUpdate()
   * - Whether enough time has passed since the last update (respects interval timing)
   * - Whether the entry is currently being updated (prevents concurrent updates)
   * Emits error events for failed updates but continues processing other entries.
   */
  async function updateLoop() {
    if (!running) return;

    const now = Date.now();

    for (const [key, keyConfig] of Object.entries(config) as Array<
      [keyof T, CacheConfig<any>]
    >) {
      const entry = cache.get(key);
      if (!entry || entry.updating) continue;

      // Skip if disabled
      if (!keyConfig.enabled) continue;

      const timeSinceUpdate = now - entry.lastUpdated;
      const shouldUpdate =
        entry.updateRequested && timeSinceUpdate >= keyConfig.interval;

      if (shouldUpdate) {
        entry.updating = true;
        entry.updateRequested = false;

        try {
          const newValue = await keyConfig.fetch();
          entry.value = newValue;
          entry.lastUpdated = Date.now();
        } catch (error) {
          const cacheError = new IntervalCacheError(
            `Error updating cache for key ${String(key)}: ${error instanceof Error ? error.message : error}`,
            String(key),
          );
          cacheError.cause = error;
          console.error(`Error updating cache for key ${String(key)}:`, error);
          emitter.emit("error", cacheError);
        } finally {
          entry.updating = false;
        }
      }
    }
  }

  /**
   * Retrieves the current cached value for a given key.
   * Returns the value instantly without any async operations.
   * Returns undefined and logs a warning if the key doesn't exist in the cache.
   */
  function get<K extends keyof T>(key: K): T[K]["value"] | undefined {
    const entry = cache.get(key);
    if (!entry) {
      console.warn(`Cache key '${String(key)}' not found`);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Immediately updates a cache entry with a new value.
   * Updates the lastUpdated timestamp and clears any pending update requests.
   * This bypasses the normal fetch mechanism and update intervals.
   */
  function set<K extends keyof T>(key: K, value: T[K]["value"]): void {
    const entry = cache.get(key);
    if (!entry) {
      throw new Error(`Cache key '${String(key)}' not found`);
    }
    entry.value = value;
    entry.lastUpdated = Date.now();
    entry.updateRequested = false; // Clear any pending update request
  }

  /**
   * Starts the cache system by populating all enabled cache entries, then begins the update loop.
   * Fails fast - if any cache entry fails to populate initially, the entire start() call fails.
   * This prevents server startup when critical cache data can't be loaded.
   * Only starts the background update intervals after successful population.
   */
  async function start(): Promise<void> {
    try {
      // Populate all enabled cache entries first
      const populatePromises: Promise<void>[] = [];

      for (const [key, keyConfig] of Object.entries(config) as Array<
        [keyof T, CacheConfig<any>]
      >) {
        // Skip if disabled
        if (!keyConfig.enabled) continue;

        const entry = cache.get(key);
        if (!entry) continue;

        populatePromises.push(
          (async () => {
            try {
              const newValue = await keyConfig.fetch();
              entry.value = newValue;
              entry.lastUpdated = Date.now();
              entry.updateRequested = false;
            } catch (error) {
              const cacheError = new IntervalCacheError(
                `Error populating cache for key ${String(key)}: ${error instanceof Error ? error.message : error}`,
                String(key),
              );
              cacheError.cause = error;
              console.error(
                `Error populating cache for key ${String(key)}:`,
                error,
              );
              emitter.emit("error", cacheError);
              throw cacheError; // Rethrow the error to propagate it
            }
          })(),
        );
      }

      // Wait for all initial populations to complete
      try {
        await Promise.all(populatePromises);
      } catch (error) {
        console.error("cache3 could not start due to population errors:", error);
        throw new Error("Failed to populate cache entries. Server start aborted.");
      }

      // Now start the update loop
      running = true;
      intervalId = setInterval(updateLoop, loopInterval);
    } catch (error) {
      console.error("cache3 could not start:", error);
      throw error;
    }
  }

  /**
   * Stops the cache system by halting the update loop and clearing all cached data.
   * After calling stop(), all cache entries are removed and get() calls will throw errors.
   * Used for cleanup when shutting down the application.
   */
  function stop() {
    running = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    cache.clear();
  }

  /**
   * Requests that a cache entry be updated during the next update cycle.
   * Does not trigger an immediate update - respects the configured interval timing.
   * Multiple calls to requestUpdate() for the same key have no additional effect.
   * The update will only occur if enough time has passed since the last update.
   */
  function requestUpdate<K extends keyof T>(key: K): void {
    const entry = cache.get(key);
    if (!entry) {
      throw new Error(`Cache key '${String(key)}' not found`);
    }
    entry.updateRequested = true;
  }

  /**
   * Forces an immediate update of a cache entry, bypassing interval timing.
   * Returns the fetched value, or undefined if the key doesn't exist or fetch fails.
   * Primarily intended for testing, but can be used to force refresh critical data.
   * Works even on disabled cache entries (with a warning).
   * Emits error events if the fetch operation fails.
   */
  async function forceUpdate<K extends keyof T>(key: K): Promise<T[K]["value"] | undefined> {
    const keyConfig = config[key];
    const entry = cache.get(key);
    if (!keyConfig || !entry) {
      console.warn(`Cache key '${String(key)}' not found`);
      return undefined;
    }

    // Skip if disabled (but allow force update to work for testing)
    if (!keyConfig.enabled) {
      console.warn(
        `Cache key '${String(key)}' is disabled but forceUpdate was called`,
      );
    }

    try {
      const newValue = await keyConfig.fetch();
      entry.value = newValue;
      entry.lastUpdated = Date.now();
      entry.updateRequested = false;
      return newValue;
    } catch (error) {
      const cacheError = new IntervalCacheError(
        `Error updating cache for key ${String(key)}: ${error instanceof Error ? error.message : error}`,
        String(key),
      );
      cacheError.cause = error;
      console.error(`Error updating cache for key ${String(key)}:`, error);
      emitter.emit("error", cacheError);
      return undefined;
    }
  }

  /**
   * Exposes the internal cache entry metadata for testing and debugging.
   * Returns an object with value, lastUpdated timestamp, updateRequested flag, and updating flag.
   * Primarily intended for testing to verify cache behavior and timing.
   */
  function getEntry<K extends keyof T>(key: K) {
    return cache.get(key);
  }

  return {
    get,
    set,
    start,
    stop,
    requestUpdate,
    forceUpdate, // For testing
    getEntry, // For testing
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
}
