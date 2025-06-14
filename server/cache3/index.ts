import { EventEmitter } from "events";

export class CacheFetchError extends Error {
  public key: string;
  public override cause: unknown;

  constructor(message: string, key: string, cause?: unknown) {
    super(message);
    this.name = "CacheFetchError";
    this.key = key;
    this.cause = cause;
  }
}

// Throws from waitUntilReady() on timeout
export class CacheTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheTimeoutError";
  }
}

// Use this helper to create each config entry so that it
// knows its prev type in the fetch fn.
// TODO: Is there a way around this?
export function createConfig<T>(
  initialValue: T,
  config: {
    enabled: boolean;
    interval: number;
    fetch: (prev: T) => Promise<T>;
  },
): CacheConfig<T> {
  return {
    initialValue,
    enabled: config.enabled,
    interval: config.interval,
    fetch: config.fetch,
  };
}

// Type-safe event definitions
export type CacheEvents<T extends CacheConfigMap> = {
  error: (error: CacheFetchError) => void;
  update: (event: {
    key: keyof T;
    value: any; // Will be properly typed at usage
  }) => void;
  ready: () => void;
};

// Type-safe EventEmitter interface
interface TypedEventEmitter<T extends CacheConfigMap> {
  on<K extends keyof CacheEvents<T>>(
    event: K,
    listener: CacheEvents<T>[K],
  ): void;
  off<K extends keyof CacheEvents<T>>(
    event: K,
    listener: CacheEvents<T>[K],
  ): void;
  once<K extends keyof CacheEvents<T>>(
    event: K,
    listener: CacheEvents<T>[K],
  ): void;
  emit<K extends keyof CacheEvents<T>>(
    event: K,
    ...args: Parameters<CacheEvents<T>[K]>
  ): boolean;
}

export type CacheConfig<T> = {
  enabled: boolean;
  initialValue: T;
  interval: number;
  fetch: (prevValue: T) => Promise<T>;
};

export type CacheConfigMap = Record<string, CacheConfig<any>>;

type CacheEntry<T> = {
  value: T;
  lastUpdated: number;
  updateRequested: boolean;
  updating: boolean;
  failureCount: number;
  backoffUntil: number;
};

export type CacheOptions = {
  loopInterval?: number;
  debug?: boolean;
  backoff?: {
    maxBackoffMs?: number;
    multiplier?: number;
  };
};

const defaultOptions: CacheOptions = {
  loopInterval: 1000,
  debug: false,
  backoff: {
    maxBackoffMs: 60000, // 1 minute
    multiplier: 2,
  },
};

export function createIntervalCache<T extends CacheConfigMap>(
  config: T,
  options: CacheOptions = defaultOptions,
) {
  const {
    loopInterval = defaultOptions.loopInterval,
    debug = defaultOptions.debug,
    backoff = defaultOptions.backoff,
  } = options;
  const {
    maxBackoffMs = defaultOptions.backoff!.maxBackoffMs!,
    multiplier = defaultOptions.backoff!.multiplier!,
  } = backoff || {};
  const cache = new Map<keyof T, CacheEntry<any>>();
  let running = false; // Don't start running until start() is called
  let intervalId: NodeJS.Timeout | null = null;
  const emitter = new EventEmitter() as EventEmitter & TypedEventEmitter<T>;
  // Prevent throwing errors when no listeners are attached
  emitter.on("error", () => {});

  // Track which enabled keys have been successfully fetched at least once
  const enabledKeys = new Set<keyof T>();
  const fetchedKeys = new Set<keyof T>();
  let readyEmitted = false;

  // Debug logging helper
  const debugLog = (...args: any[]) => {
    if (debug) {
      console.log("[IntervalCache debug]", ...args);
    }
  };

  // Initialize cache with all keys
  for (const [key, keyConfig] of Object.entries(config)) {
    // Validate and normalize interval - minimum 1000ms unless Infinity
    if (keyConfig.interval !== Infinity && keyConfig.interval < 1000) {
      console.warn(
        `Cache key '${String(key)}' interval ${keyConfig.interval}ms is too short, defaulting to 1000ms`,
      );
      keyConfig.interval = 1000;
    }

    // Track enabled keys for ready state
    if (keyConfig.enabled) {
      enabledKeys.add(key);
    }

    cache.set(key, {
      value: keyConfig.initialValue,
      lastUpdated: -Math.random() * keyConfig.interval, // Random jitter to spread out updates
      updateRequested: keyConfig.enabled, // Only request if enabled
      updating: false,
      failureCount: 0,
      backoffUntil: 0,
    });
  }

  // Check if ready immediately (in case all keys are disabled) - do this asynchronously
  // so that waitUntilReady() has a chance to set up listeners first
  process.nextTick(checkAndEmitReady);

  // Helper function to check if all enabled keys have been fetched and emit ready event
  function checkAndEmitReady() {
    if (!readyEmitted) {
      // If no enabled keys, emit ready immediately
      if (enabledKeys.size === 0) {
        readyEmitted = true;
        debugLog("No enabled cache keys - emitting ready event immediately");
        emitter.emit("ready");
        return;
      }

      // Check if all enabled keys have been fetched
      if (fetchedKeys.size >= enabledKeys.size) {
        for (const key of enabledKeys) {
          if (!fetchedKeys.has(key)) {
            return; // Not all enabled keys have been fetched yet
          }
        }
        readyEmitted = true;
        debugLog(
          "All enabled cache keys have been fetched - emitting ready event",
        );
        emitter.emit("ready");
      }
    }
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
    // Don't update while stopped
    if (!running) {
      return;
    }

    const now = Date.now();

    for (const [key, keyConfig] of Object.entries(config)) {
      const entry = cache.get(key);

      // Skip if updating (an entry should never have more than one fetch in flight)
      if (!entry || entry.updating) {
        continue;
      }

      // Skip if disabled
      if (!keyConfig.enabled) {
        continue;
      }

      // Skip if still in backoff period
      if (now < entry.backoffUntil) {
        continue;
      }

      const timeSinceUpdate = now - entry.lastUpdated;

      // Auto-request updates when interval has passed
      if (timeSinceUpdate >= keyConfig.interval) {
        entry.updateRequested = true;
      }

      // Update if requested and not already updating
      if (entry.updateRequested) {
        entry.updating = true;
        entry.updateRequested = false;

        try {
          const newValue = await keyConfig.fetch(entry.value);
          entry.value = newValue;
          entry.lastUpdated = Date.now();
          // Reset failure count on success
          entry.failureCount = 0;
          entry.backoffUntil = 0;
          debugLog(`Successfully updated key '${String(key)}'`);

          // Track that this key has been fetched
          fetchedKeys.add(key);

          // Emit update event
          emitter.emit("update", { key, value: newValue });

          // Check if all enabled keys are now ready
          checkAndEmitReady();
        } catch (error) {
          // Increment failure count and calculate backoff
          entry.failureCount++;
          const backoffMs = Math.min(
            Math.pow(multiplier, entry.failureCount - 1) * 1000,
            maxBackoffMs,
          );
          entry.backoffUntil = Date.now() + backoffMs;

          const cacheError = new CacheFetchError(
            `Error updating cache for key ${String(key)}: ${error instanceof Error ? error.message : error}`,
            String(key),
            error,
          );
          console.error(
            `Error updating cache for key ${String(key)} (attempt ${entry.failureCount}, backing off ${backoffMs}ms):`,
            error,
          );
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
  function get<K extends keyof T>(
    key: K,
  ): T[K] extends CacheConfig<infer V> ? V : never {
    const entry = cache.get(key);
    if (!entry) {
      console.warn(`Cache key '${String(key)}' not found`);
      return undefined as any;
    }
    return entry.value;
  }

  /**
   * Immediately updates a cache entry with a new value.
   * Updates the lastUpdated timestamp and clears any pending update requests.
   * This bypasses the normal fetch mechanism and update intervals.
   */
  function set<K extends keyof T>(
    key: K,
    value: T[K] extends CacheConfig<infer V> ? V : never,
  ): void {
    const entry = cache.get(key);
    if (!entry) {
      throw new Error(`Cache key '${String(key)}' not found`);
    }
    debugLog(`Manually setting value for key '${String(key)}'`);
    entry.value = value;
    entry.lastUpdated = Date.now();
    entry.updateRequested = false; // Clear any pending update request
    // Do NOT reset backoff state - backoff is for fetch() failures, not manual sets
  }

  /**
   * Starts the background update loop.
   * Cache entries start with their initialValues and get updated by the background loop.
   * Simple and synchronous - just starts the interval timer.
   */
  function start(): void {
    if (running) {
      return;
    }
    debugLog(
      `Starting cache with ${Object.keys(config).length} keys, loopInterval: ${loopInterval}ms`,
    );
    running = true;
    intervalId = setInterval(updateLoop, loopInterval);
  }

  /**
   * Stops the background update loop while preserving all cached data.
   * Cache entries remain accessible via get() after stopping.
   * Use this to pause automatic updates without losing cached values.
   */
  function stop() {
    debugLog("Stopping cache");
    running = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
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
    debugLog(`Requesting update for key '${String(key)}'`);
    entry.updateRequested = true;
  }

  /**
   * Forces an immediate update of a cache entry, bypassing interval timing.
   * Returns the fetched value, or undefined if the key doesn't exist or fetch fails.
   * Primarily intended for testing, but can be used to force refresh critical data.
   * Works even on disabled cache entries (with a warning).
   * Emits error events if the fetch operation fails.
   */
  async function forceUpdate<K extends keyof T>(
    key: K,
  ): Promise<T[K] extends CacheConfig<infer V> ? V : never> {
    const keyConfig = config[key];
    const entry = cache.get(key);
    if (!keyConfig || !entry) {
      console.warn(`Cache key '${String(key)}' not found`);
      return undefined as any;
    }

    // Skip if disabled (but allow force update to work for testing)
    if (!keyConfig.enabled) {
      console.warn(
        `Cache key '${String(key)}' is disabled but forceUpdate was called`,
      );
    }

    try {
      debugLog(`Force updating key '${String(key)}'`);
      const newValue = await keyConfig.fetch(entry.value);
      Object.assign(entry, {
        value: newValue,
        lastUpdated: Date.now(),
        updateRequested: false,
        // Reset failure count on success
        failureCount: 0,
        backoffUntil: 0,
      });
      debugLog(`Successfully force updated key '${String(key)}'`);

      // Track that this key has been fetched
      fetchedKeys.add(key);

      // Emit update event
      emitter.emit("update", { key, value: newValue });

      // Check if all enabled keys are now ready
      checkAndEmitReady();

      return newValue;
    } catch (error) {
      // Increment failure count and calculate backoff for forceUpdate too
      entry.failureCount++;
      const backoffMs = Math.min(
        Math.pow(multiplier, entry.failureCount - 1) * 1000,
        maxBackoffMs,
      );
      entry.backoffUntil = Date.now() + backoffMs;

      const cacheError = new CacheFetchError(
        `Error updating cache for key ${String(key)}: ${error instanceof Error ? error.message : error}`,
        String(key),
        error,
      );
      console.error(
        `Error force updating cache for key ${String(key)} (attempt ${entry.failureCount}, backing off ${backoffMs}ms):`,
        error,
      );
      emitter.emit("error", cacheError);
      return undefined as any;
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

  let waitUntilReadyPromise: Promise<void> | null = null;

  function waitUntilReady({
    timeout = 10_000,
  }: { timeout?: number } = {}): Promise<void> {
    if (waitUntilReadyPromise) {
      return waitUntilReadyPromise;
    }

    // If already ready, resolve immediately
    if (readyEmitted) {
      waitUntilReadyPromise = Promise.resolve();
      return waitUntilReadyPromise;
    }

    waitUntilReadyPromise = new Promise((resolve, reject) => {
      // Check again in case ready was emitted between the check above and setting up the listener
      if (readyEmitted) {
        resolve();
        return;
      }

      // Set up timeout
      const timeoutId = setTimeout(() => {
        emitter.off("ready", onReady);
        waitUntilReadyPromise = null; // Reset so next call can create a new promise
        reject(
          new CacheTimeoutError(`Cache not ready within ${timeout}ms timeout`),
        );
      }, timeout);

      // Set up ready listener
      const onReady = () => {
        clearTimeout(timeoutId);
        resolve();
      };

      emitter.once("ready", onReady);
    });
    return waitUntilReadyPromise;
  }

  return {
    get,
    set,
    start,
    stop,
    waitUntilReady,
    requestUpdate,
    forceUpdate, // For testing
    getEntry, // For testing
    on: emitter.on.bind(emitter) as TypedEventEmitter<T>["on"],
    off: emitter.off.bind(emitter) as TypedEventEmitter<T>["off"],
    once: emitter.once.bind(emitter) as TypedEventEmitter<T>["once"],
    emit: emitter.emit.bind(emitter) as TypedEventEmitter<T>["emit"],
  };
}
