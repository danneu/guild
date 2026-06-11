# AGENTS.md

Guidance for AI agents working in the `img-proxy` subproject.

## Project Overview

A Cloudflare Worker that proxies external images for the Guild forum, caching
them permanently in Cloudflare R2. Use case: forum BBCode `[img]{url}[/img]` is
rewritten to a proxied image tag, so images survive even after the origin server
goes offline.

## Commands

- `pnpm run dev` - Local dev server via Wrangler (`wrangler dev`)
- `pnpm run deploy` - Deploy to Cloudflare Workers (`wrangler deploy`)
- `pnpm test` - Run tests (`vitest run`); `pnpm run test:watch` to watch

There is no separate TypeScript compile step -- the worker runs TypeScript
directly via Wrangler.

## Architecture

Entry point `src/index.ts` handles HTTP requests and image caching.

- `src/index.ts` - Worker entry: routing + image proxy logic
- `src/routes/` - Request handlers
- `src/config.ts` - Configuration
- `src/types.ts` - Shared types
- `src/util/` - Helpers (URL normalization/validation, canonicalization, Result type)

**Request flow:**

1. Client requests `/?url=https://example.com/image.jpg`
2. URL is validated and normalized (blocks localhost, private IPs, ports)
3. Check R2 for an existing image using the canonicalized key
4. On miss: fetch original, validate format/size, store in R2
5. Return the image with long-lived cache headers

**Security:** blocks localhost and private IP ranges, rejects URLs with ports,
validates image format via magic bytes, enforces a 10MB size limit with timeout,
and validates content-type (images only).

**Storage:** images stored in R2 under keys like
`proxied/example.com/path/to/image.jpg`. URLs are canonicalized (query params
sorted) for consistent cache keys. Cache headers set for permanent storage
(`max-age=31536000, immutable`).

## Configuration

- `wrangler.toml` - Worker config + R2 bucket binding (`R2_BUCKET`)
- `worker-configuration.d.ts` - Cloudflare Worker API type definitions

## Testing

Vitest (Node environment). Tests focus on URL validation/normalization logic in
`src/util/`.

## Code style

Plain ASCII over fancy Unicode unless the file already uses it. Format with
Prettier (`.prettierrc`).
