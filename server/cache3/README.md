A vibe-coded rewrite of the interval-cache thingy I've implemented a few times in this project.

- lib/interval-cache.ts
- server/cache2.ts

Trying to unify them into a decent API. But don't feel like spending time on it.

The purpose of the cache is:

1. It initializes with a value
2. It updates each cache item in the background, each key at a unique interval
3. Fetching from cache is always instant
   Back when I first wrote it, the caches I found would populate the cache on demand which
   isn't I want for things like, say, the state of the homepage.

- cache.get(key) should return a type-safe value instantly
- cache.set(key, value) should update the value instantly and update lastUpdated to now
- cache.requestRefresh(key) shouldn't do anything but set `updateRequested` on the value so that the cache's next run will update the value. Even if requestRefresh(key) is run many times, it should never update any faster than the interval
- cache.getEntry(key) should return the entry object for testing
- cache.start() returns a promise that resolves once every key has been populated. and only until then will the internal update interval start. this is so we can do things like prevent server boot if the cache can't populate.
