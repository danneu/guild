# Cache3 - Type-Safe Interval Cache

A robust interval-based cache system with automatic background updates, exponential backoff, and type safety.

## Features

- **Type-safe API**: Full TypeScript support with proper type inference
- **Background updates**: Each cache key updates automatically at its own interval  
- **Instant access**: `cache.get(key)` always returns immediately with cached value
- **Exponential backoff**: Per-key error handling with configurable backoff
- **Random jitter**: Prevents thundering herd with staggered update timing
- **Type-safe events**: Listen to `update` and `error` events with proper typing
- **Debug logging**: Optional verbose logging for troubleshooting
- **Robust logic**: Automatic update requests with manual override capability

## API

### Core Methods

- **`cache.get(key)`** - Returns type-safe cached value instantly
- **`cache.set(key, value)`** - Updates value instantly, preserves backoff state  
- **`cache.requestUpdate(key)`** - Requests update on next cycle (respects interval timing)
- **`cache.forceUpdate(key)`** - Forces immediate update, returns Promise with new value
- **`cache.start()`** - Starts the background update loop
- **`cache.stop()`** - Stops update loop, preserves cached data
- **`cache.getEntry(key)`** - Returns cache metadata for testing/debugging

### Events

- **`cache.on('update', ({ key, value }) => {})`** - Emitted on successful updates
- **`cache.on('error', (error) => {})`** - Emitted on fetch failures with key info

### Options

```typescript
{
  loopInterval?: number;     // How often to check for updates (default: 1000ms)
  debug?: boolean;          // Enable verbose logging (default: false)
  backoff?: {
    maxBackoffMs?: number;  // Max backoff time (default: 60000ms)
    multiplier?: number;    // Backoff multiplier (default: 2)
  };
}
```

## Behavior

- **Initialization**: Each key starts with `initialValue` and random jitter offset
- **Auto-updates**: Keys automatically request updates when their interval elapses
- **Interval respect**: Manual `requestUpdate()` calls still honor interval timing
- **Backoff preservation**: `cache.set()` does NOT reset backoff (backoff is for fetch failures)
- **Concurrent protection**: Only one update per key at a time
- **Graceful errors**: Failed updates preserve existing values and emit error events
