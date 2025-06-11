const debug = require('debug')('interval-cache')
const assert = require('assert')

// Copied from https://github.com/danneu/interval-cache/

module.exports = class Cache {
    constructor(clock = global) {
        // Let us inject a clock for testing
        this.clock = clock
        this.intervalId = null
        // Map of the keys that are currently running their step() function
        // Maps key to milliseconds since epoch of lock start
        this.locks = new Map()
        // Mapping of key to {ms, step, lastRun, value}
        this.tasks = Object.create(null)
        // Avoids multiple start() calls from starting multiple loops
        this.started = false
    }

    // Starts the update loop and return the cache instance
    //
    // The default resolution in 1000ms which means that the
    // cache checks for keys that need to be updated every second.
    start(frequency = 1000) {
        assert(Number.isInteger(frequency))
        debug('cache starting...')

        // Noop if already started
        if (this.started) {
            return this
        }

        this.started = true
        this.intervalId = this.clock.setInterval(() => this.tick(), frequency)

        return this
    }

    stop() {
        debug('cache stopping...')
        this.started = false
        this.clock.clearInterval(this.intervalId)
        this.intervalId = null
        return this
    }

    // Check each task's .lastRun timestamp to see if it needs to
    // be step()'ed.
    async tick() {
        const promises = []

        for (const key of Object.keys(this.tasks)) {
            // Skip tasks that aren't yet due for a refresh
            if (this.clock.Date.now() - this.tasks[key].lastRun < this.tasks[key].ms) {
                continue
            }

            promises.push(this.refresh(key))
        }

        return Promise.all(promises)
    }

    // Synchrnously return a key's value.
    get(key) {
        assert(typeof key === 'string')

        // Handle nonexistent key
        if (!this.tasks[key]) {
            return undefined
        }

        return this.tasks[key].value
    }

    // SYNCHRONOUS UPDATES
    //
    // These update a task's value and reset the interval.

    // Synchronously set a key to a given value.
    set(key, value) {
        assert(typeof key === 'string')
        debug(`[set] ${key} = %j`, value)
        this.tasks[key].value = value
        this.tasks[key].lastRun = this.clock.Date.now()
        return this
    }

    // Synchronously apply a transformation on a key's value.
    //
    // `transform` is a function (oldValue) => newValue
    // `transform` will received undefined if key does not exist.
    update(key, transform) {
        assert(typeof key === 'string')
        assert(typeof transform === 'function')

        return this.set(key, transform(this.get(key)))
    }

    // ASYNCHRONOUS UPDATES

    // Trigger asynchronous update
    //
    // Returns Promise<nextValue>
    //
    // Run's the task's step() promise.
    // - Ensures each task is running only once
    // - If .set()/.update() update task's value while step() is running,
    //   the step() result is discarded.
    async refresh(key) {
        assert(typeof key === 'string')
        debug(`[refresh] refreshing ${key}...`)
        // Refresh is already in flight, so do nothing
        if (this.locks.has(key)) {
            debug(
                `[refresh] --bail-- lock taken for ${key}. lock age = ${Date.now() -
                    this.locks.get(key)}ms`
            )
            return undefined
        }

        // Grab lock
        this.locks.set(key, Date.now())

        const { step, lastRun: prevRun, value: prevValue } = this.tasks[key]

        // If anything goes wrong, our next value is simply our prev value
        let nextValue = prevValue
        try {
            nextValue = await step(prevValue)
        } catch (err) {
            // On error, we do nothing but hope the next interval is more successful
            console.error(`[IntervalCache] Error updating cache key "${key}"`, err)
        } finally {
            // Release lock
            this.locks.delete(key)
        }

        // If lastRun changed while we were step()'ing, then
        // .set() was used, so discard this result and return the fresher value
        if (prevRun !== this.tasks[key].lastRun) {
            debug(`[refresh] --bail-- prevRun !== lastRun`)
            return this.get(key)
        }

        // step() was successful and uninterrupted, so now we can update our state.
        debug(`[refresh] --ok-- setting ${key} = %j`, nextValue)
        this.set(key, nextValue)

        return nextValue
    }

    // TASKS

    // Create a key that updates at an interval indefinitely.
    //
    // Returns Cache instance for chaining
    every(key, ms, step, initValue) {
        assert(typeof key === 'string')
        assert(typeof step === 'function')
        assert(Number.isInteger(ms))

        // lastRun starts at 0 so that it always runs on first start() loop
        this.tasks[key] = { ms, step, lastRun: 0, value: initValue }

        return this
    }

    // Create a key that updates once and never again.
    once(key, step, initValue) {
        assert(typeof key === 'string')
        assert(typeof step === 'function')

        this.tasks[key] = { ms: Date.now(), step, lastRun: 0, value: initValue }

        return this
    }
}