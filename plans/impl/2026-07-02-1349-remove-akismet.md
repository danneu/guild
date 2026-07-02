# Remove Akismet entirely; repoint stale references to the Claude antispam system

## Context

Spam detection on first posts was migrated from Akismet to a Claude API
classifier in the plan `plans/impl/2026-06-27-1455-claude-antispam-classifier.md`.
That migration deliberately **left all Akismet code in place for rollback** and
explicitly deferred its deletion to a follow-up ("once the Claude path is proven
in production, delete `server/akismet/` and `server/services/antispam/akismet.ts`
and drop `AKISMET_KEY`").

This change performs that follow-up. The justification is **not** that the Claude
path is flawless -- it isn't (a casino-spam post bypassed it via an `API_TIMEOUT`
fail-open on 2026-07-01; see `plans/impl/2026-07-01-1608-fly-log-history-helper.md`,
and `claude.ts:253` still fails open on timeout). The justification is narrower:
the Akismet code is **unreachable dead rollback code** and reverting to it is not a
useful option, so it is safe to delete while leaving the Claude runtime behavior
unchanged. Alongside the deletion, repoint the handful of stale comments/strings/docs
that still name "Akismet" so they refer to the current Claude antispam system.

**Out of scope (separate open follow-up):** the Claude classifier's
timeout / retry / fail-open reliability work. That is a distinct task (already noted
in the 2026-07-01 ops plan), and this cleanup must not alter that behavior.

Key facts established during exploration:

- The **live spam path is `services.antispam.process` -> `claude.analyze`** and does
  **not** touch Akismet. It stays untouched.
- **Akismet is already dead code.** Nothing reachable calls `akismet.checkComment`
  or the `antispam/akismet.ts` wrapper. `AKISMET_KEY` is read only inside
  `server/akismet/index.ts` (which is being deleted).
- There is **no `akismet-api` npm dependency** (raw `fetch`), **no Akismet SQL
  columns/tables**, **no Akismet views**, and **no cron jobs**. Nothing to remove
  in those areas.
- The **nuke infrastructure** (`db.nukeUser`/`unnukeUser`, `users.is_nuked`,
  `nuked_users`, `approved_at`, and the mod views in `views/`) is backend-neutral
  and shared by both the Claude auto-nuke and manual mod nukes. **Do not touch it.**
- `substring.ts` in the antispam dir appears orphaned, but it is **not** Akismet
  and is **out of scope** here.

## Files to delete

- `server/akismet/` (the whole directory — only file is `index.ts`, the raw Akismet
  REST client using `config.AKISMET_KEY`).
- `server/services/antispam/akismet.ts` (the dead `analyze()` wrapper; its only
  import was `../../akismet`).

## Files to edit

### Config

- `server/config.ts` — delete the `AKISMET_KEY` export and its comment (lines
  140-141). Leave the Claude block below it (`ANTHROPIC_API_KEY`,
  `IS_ANTISPAM_CONFIGURED`, the "Antispam (Claude) configured" log) intact.
- `.env.example` — delete the `AKISMET_KEY=` line (line 36, inside the
  `# --- Anti-spam / CAPTCHA ---` section). Keep the section header (shared with
  reCAPTCHA/Turnstile). Also **move the stray `ANTHROPIC_API_KEY` entry and its
  comment** (currently orphaned at the very bottom, lines 85-86) up into this
  Anti-spam / CAPTCHA section, so the antispam key lives with the other anti-spam
  config instead of dangling at the end of the file. Net effect: the section holds
  the real antispam key (`ANTHROPIC_API_KEY`) plus the CAPTCHA keys, and no
  `AKISMET_KEY`.

### Stale comments / strings -> repoint to Claude antispam

- `server/services/index.ts:10` — remove the stale `// TODO: Move akismet
  spam-check here.` (the spam check already lives under `services.antispam`).
- `server/middleware/index.ts:81` — reword the rate-limit comment "Now that we
  have akismet, 10 seconds is long enough." to reference the antispam classifier
  instead of Akismet (behavior unchanged; comment only).
- `server/emailer.ts` — the `sendAutoNukeEmail` function (lines 80-89+) is **dead**:
  its only call site is already commented out at `server/services/antispam/index.ts:52`,
  and its template hard-codes "Akismet detected spammer:". **Delete the
  `sendAutoNukeEmail` function entirely** (the auto-nuke email was intentionally
  disabled as redundant with the Discord broadcast). Verify no other importer first
  with `grep -rn sendAutoNukeEmail server/` — exploration confirmed the only
  references are its definition and the commented call.
- `server/services/antispam/index.ts` — **in scope only for deleting the dead email
  lines**: remove the commented-out call `// emailer.sendAutoNukeEmail(...)` (line 52)
  and its adjacent `// Send email (Turned off for now...)` comment (line 51). Make
  **no** executable or behavioral change to this file; the live Claude `process()`
  logic stays exactly as-is.

### Docs

- `AGENTS.md`:
  - Line ~48: drop `server/akismet/` from the integrations/subsystems bullet
    (keep `server/discord/`, `server/cache3/`).
  - Line ~65: remove "Akismet" from the API-keys list ("email/SES, S3 uploads,
    Akismet, Turnstile CAPTCHA, Discord").
  - Line ~86-87: reword "Akismet spam detection + user reporting + mod tools" to
    describe the current mechanism (e.g. "Claude-based spam detection") — this is
    the one place a doc should be *repointed* rather than just deleted.

### Historical migration plan (leave unchanged)

- `plans/impl/2026-06-27-1455-claude-antispam-classifier.md` contains ~30
  historical Akismet references and documents the now-retired rollback path.
  **Leave it unchanged** -- `plans/impl/` is an archive of work already done, and the
  doc should keep accurately recording what happened (including the rollback path
  that this cleanup retires). Do not scrub or edit its body.

## Explicitly out of scope / do NOT touch

- **Executable behavior of the Claude antispam path** -- `claude.ts`, `policy.ts`,
  and the live `process()` logic in `server/services/antispam/index.ts`, plus their
  tests (`index.test.ts`, `policy.test.ts`). This cleanup only *deletes the dead
  commented email lines* in `index.ts` (see the Config/strings section); no runtime
  behavior of the Claude classifier changes.
- The classifier's timeout / retry / fail-open reliability fix -- a **separate open
  follow-up** (per the 2026-07-01 ops plan), not part of this cleanup.
- `ANTHROPIC_API_KEY` / `IS_ANTISPAM_CONFIGURED` in `server/config.ts` (the export
  itself; the `.env.example` reorganization above only relocates the example entry).
- Nuke infrastructure: `db.nukeUser`/`unnukeUser`, `users.is_nuked`,
  `nuked_users` table, `approved_at`, and all nuke/approve UI in `views/`
  (`show_user.html`, `lexus_lounge.html`, `list_user_alts.html`, etc.).
- `server/services/antispam/substring.ts` (orphaned but unrelated to Akismet).
- Discord broadcasts (`broadcastAutoNuke`, `broadcastSpamReview`, etc.).

## Verification

1. `pnpm run check` — TypeScript must pass. This is the key guard: after deleting
   `server/akismet/` and `server/config.ts`'s `AKISMET_KEY`, any lingering import
   or reference (e.g. the dead `antispam/akismet.ts` if missed) surfaces as a
   type/module-resolution error.
2. `grep -rin akismet server/ .env.example AGENTS.md` — should return **no
   matches** after the edits (the historical plan under `plans/impl/` is expected
   to still match if left as-is per the decision above).
3. `pnpm test` — the antispam tests (`index.test.ts`, `policy.test.ts`) exercise
   the Claude path only and must still pass; confirms the removal didn't disturb
   the live spam flow.
4. Smoke the live path is unaffected: confirm `services.antispam.process` still
   resolves and the three call sites in `server/index.ts` (~1190 reply, ~1407
   topic, ~1518 edit) are untouched. `scripts/antispam-probe.ts` remains runnable
   against the Claude adapter if a live check is desired.
