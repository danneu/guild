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

  // Main update loop
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

  function get<K extends keyof T>(key: K): T[K]["value"] {
    const entry = cache.get(key);
    if (!entry) {
      throw new Error(`Cache key '${String(key)}' not found`);
    }
    return entry.value;
  }

  function set<K extends keyof T>(key: K, value: T[K]["value"]): void {
    const entry = cache.get(key);
    if (!entry) {
      throw new Error(`Cache key '${String(key)}' not found`);
    }
    entry.value = value;
    entry.lastUpdated = Date.now();
    entry.updateRequested = false; // Clear any pending update request
  }

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

  function stop() {
    running = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    cache.clear();
  }

  function requestUpdate<K extends keyof T>(key: K): void {
    const entry = cache.get(key);
    if (!entry) {
      throw new Error(`Cache key '${String(key)}' not found`);
    }
    entry.updateRequested = true;
  }

  // Force immediate update (for testing)
  async function forceUpdate<K extends keyof T>(key: K): Promise<void> {
    const keyConfig = config[key];
    const entry = cache.get(key);
    if (!keyConfig || !entry) {
      throw new Error(`Cache key '${String(key)}' not found`);
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
    } catch (error) {
      const cacheError = new IntervalCacheError(
        `Error updating cache for key ${String(key)}: ${error instanceof Error ? error.message : error}`,
        String(key),
      );
      cacheError.cause = error;
      console.error(`Error updating cache for key ${String(key)}:`, error);
      emitter.emit("error", cacheError);
    }
  }

  // Expose internals for testing
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
