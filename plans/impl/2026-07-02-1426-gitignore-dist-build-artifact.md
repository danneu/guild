# Plan: gitignore the `dist/` build artifact

## Context

`dist/` is the Gulp asset-build output (concatenated + minified `all-<hash>.css`
/ `all-<hash>.js`, `fonts/`, and `rev-manifest.json`). It is a pure build
artifact:

- Produced only by `pnpm run build` (`gulp`), which even wipes it first
  (`deleteAsync(["dist/**/*"])` in `gulpfile.ts`).
- Rebuilt from scratch in the production image (`Dockerfile`: `RUN pnpm run
build` -> `COPY --from=build /app/dist ./dist`), and already excluded from the
  image context by `.dockerignore` (`dist`, "will be rebuilt").
- Read by the server at boot to set `ctx.dist` (`server/index.ts:54`); when
  absent the app runs fine and templates fall back to individual assets
  (`views/layouts/master.html:34,205`).

Today it is **untracked and unignored**, so it shows up as `?? dist/` noise in
`git status`. Nothing in git depends on it. It should be ignored, exactly like
the analogous compiled-server output `build/` already is.

Verified facts:
- `git ls-files dist/` -> 0 files, so nothing is tracked; no `git rm --cached`
  needed.
- Only one `dist` directory exists outside `node_modules` (the repo-root one).
- `img-proxy/` has no `dist` and no separate `.gitignore`.

## Change

Add a single anchored entry to the root `.gitignore`, placed next to the
existing `build` line (both are compiled artifacts):

```
build
/dist
```

Use the anchored form `/dist` (not bare `dist`) so it targets only the repo-root
build output and cannot accidentally match a nested `dist` elsewhere.

**File:** `.gitignore` (root)

No other files change. `.dockerignore` already ignores `dist`, so prod builds are
unaffected. The existing local `dist/` folder stays on disk (ignoring does not
delete it) and simply stops appearing in `git status`.

## Optional follow-up (not required)

A stale local `dist/` makes even the dev server serve old bundled assets
(`server/index.ts` reads `rev-manifest.json` on boot regardless of `NODE_ENV`),
masking source edits. If desired, `rm -rf dist` clears it; `pnpm run build`
regenerates it. This is operational cleanup, not part of the gitignore change.

## Verification

1. `git status --porcelain` -> `?? dist/` line is gone (no longer listed).
2. `git check-ignore dist` -> prints `dist` (confirms the rule matches).
3. `git check-ignore dist/rev-manifest.json` -> matches (the tree is ignored).
4. Sanity that nothing tracked was affected: `git status` shows only the
   `.gitignore` edit staged/modified.
