# Require email confirmation before writing

## Context

Anyone can register and immediately post. `users.email_verified` exists but gates
nothing: it only decides whether a user receives PM notification emails
(`server/routes/convos.ts`) and renders a badge on the profile editor. No
verification email is sent at registration -- the only path to verifying is
discovering the button on `/me/edit`.

We want a confirmed email address to be a precondition for every write action on
the forum. Reads stay open. Existing accounts are grandfathered so nobody who has
been here for years is disrupted.

Two design constraints shape everything below:

1. **Nobody can be locked out with no recovery path.** A typo'd address, a dead
   address, a mail-delivery outage, or a mid-deploy race must all be recoverable.
   Self-service where possible; where mail delivery itself is down, an operational
   path that does not require a deploy.
2. **PM notification email volume must not change.** Grandfathering every
   existing user into a single `verified` state would flip the mailer filter open
   for ~20 years of accounts with dead addresses. Bounces damage SES sender
   reputation.

Constraint 2 is why there are two columns rather than one.

## Data model

Two independent stamps on `users`, with distinct meanings:

| column | meaning | gates writes | gates mail |
| --- | --- | --- | --- |
| `email_verified_at timestamptz NULL` | this address was confirmed by clicking a link | yes | yes (from phase 3) |
| `email_gate_exempt_at timestamptz NULL` | this account is excused from the gate | yes | no |

- **Write gate predicate:** `email_verified_at IS NOT NULL OR email_gate_exempt_at IS NOT NULL`
- **Mailer predicate:** the legacy `email_verified` boolean until phase 3, then
  `email_verified_at IS NOT NULL`. See Rollout for why the switch is deferred.

Exemption is granted to: all pre-existing accounts at migration time, any account
created while `config.IS_EMAIL_CONFIGURED` is false (see Fail-open), and any
account staff excuse -- individually through the new staff action, or in bulk
during a mail-delivery outage (see Recovery).

Plus `email_verification_tokens`, modeled on `reset_tokens` (`user_id`, `token
uuid`, `created_at`, `expired_at` defaulting to 24h out, and an
`active_email_verification_tokens` view, per the house `expired_at` + `active_*`
idiom) -- with two departures that are load-bearing:

- **`email text NOT NULL`: the token carries the address it confirms.** The token
  row *is* the pending-address state; there is no `pending_email` column on
  `users`. Confirmation writes the address recorded on the token, so the address
  that gets verified is by construction the address the clicked link was mailed to.
- **`UNIQUE (user_id)`: at most one token row per user, enforced by the database.**
  Issuance is a single atomic upsert on that row, so the surviving row is always
  one complete (token, address) pair, and a link mailed to a superseded address
  stops working.

**Invariant I1:** an address becomes verified only if the clicked link was mailed
to that address. Splitting pending state across a `users` column and a token row
would break I1 under interleaved issuance -- two address changes racing can leave
the surviving token bound to address A while the users column holds address B, and
clicking A's link would then verify B. Carrying the address on the token dissolves
that race rather than fencing it.

**Invariant I2:** after account creation, `users.email` is written by exactly one
code path -- confirmation. Every address change, for verified and unverified users
alike, is staged on the token row and nowhere else. The user's `email` and
`email_verified_at` stay untouched until confirmation, so a typo can never lock out
an established member; it simply never confirms.

**Invariant I3:** the token row is the pending-address state *whether or not it has
expired*. Expiry kills the link, not the staged address. The row survives until it
is confirmed, replaced by a newer staging, or explicitly cleaned up. Consequently
resend never chooses a destination: it renews the row's stored address with a fresh
token value and expiry, and the UI keeps showing that address as pending. Every
reader of pending state -- throttle guard, wall page, profile panel -- reads the
base table, not the active view.

**Uniqueness:** no unique constraint on the token's `email`. The address is only
*claimed* at confirmation, where the existing `unique_email` index on
`lower(email)` enforces it atomically inside the swap. First-to-confirm wins. A
unique index on the staged address would let anyone squat an address they don't
own for 24h.

This replaces the current token scheme entirely: today's link is a deterministic
`HMAC-SHA512(SECRET, email)` that never expires and is replayable forever.
`config.SECRET` becomes unused; leave the entry with a comment noting so.

## Enforcement

One middleware, `requireConfirmedEmail()`, mounted after the current-user and
flash middleware and before `ctx.render` / `ctx.back` exist (so it redirects, and
the source comments why). It is the sole enforcement point.

```
if (!ctx.currUser) -> next()                      // guests are not gated
if (gate predicate passes) -> next()
if (ctx.method is GET/HEAD/OPTIONS) -> next()
if (allowlisted {method, path}) -> next()
if (ctx.path.startsWith("/api/")) -> ctx.throw(403, msg)
else -> ctx.flash = {message:["danger", msg]}; ctx.redirect("/confirm-email")
```

Fail-closed: any route added later is gated by default.

The gate reads `ctx.method`, the value `methodOverride` has already rewritten from
`_method` and the same value the router dispatches on, so a `POST` carrying
`_method=GET` reaches only the GET handler. No bypass.

**Allowlist** -- exact `{method, path}` matches, with one regex for the
parameterized notification route:

| entry | why |
| --- | --- |
| `POST /me/logout` | the nav logout form |
| `POST /sessions` | log in |
| `POST /users` | register while holding a stale unverified cookie; Turnstile-protected |
| `POST /forgot` | **lockout fix.** Registration sets a 1-year session cookie, so "I forgot which password I typed" hits this while gated. Already rate-limited by the active-reset-token check |
| `POST /reset-password` | **lockout fix.** Creates a session; blocking it is a hard stop |
| `POST /api/verify-email` | resend |
| `PUT /me/email` (new) | change the address you're confirming |
| `DELETE /me/notifications`, `DELETE /me/notifications/convos`, `DELETE /api/me/notifications/:id` | registration sends a welcome PM, so a gated user lands with a notification badge they otherwise cannot clear. The `/api/` one hard-403s an XHR with no UI feedback |

Deliberately **not** allowlisted: everything else, including avatar upload.

**Out of scope, by choice:** no changes to the create-post/topic/PM/convo
capabilities in `server/cancan.ts`, and no hiding of post/reply forms in views.
Consequence: a gated user can open a reply form and get bounced on submit. The
site-wide banner handles discovery. (The one exception is the new staff action,
which does need a cancan entry.)

## Routes and flows

**Registration** -- after the session cookie is set, create a token, send the
verification email, redirect to `/confirm-email` instead of `/`. The welcome PM
stays as-is. A send failure must not surface as an error: the user row and session
already exist, and a 500 followed by a retry yields "Username is taken". The resend
button is the recovery.

**`GET /confirm-email`** -- the wall page. Shows the address awaiting confirmation,
a resend button, and a "wrong address?" form posting to `PUT /me/email`.

**`GET /verify-email?token=<uuid>`** -- rewritten. No HMAC, no `email` query param,
and no auto-login when logged out: verify, then redirect to `/login` with a flash.
(The password reset flow already covers account recovery; the link should not be a
bearer credential.) Consumes the token, sets `email_verified_at = NOW()`, and writes
the address **recorded on the token row** into `users.email` (I1). It must never
read a staged address from anywhere else.

**`PUT /me/email`** (new) -- the change-address route. It issues a token for the
new address and does nothing else; there is no verified/unverified branch and it
never touches `users.email` (I2). The `email` field of the existing omnibus profile
handler `PUT /users/:slug` routes here and likewise stops writing `users.email`.
Consequently `updateUser` loses both its `email` and `email_verified` slots: a
surviving `email` slot would be a second writer that changes the address while
`email_verified_at` stays set.

**Case-insensitive comparison.** `unique_email` is on `lower(email)`, so a
case-only edit is a no-op, not a new staging. Do **not** lowercase on write -- that
silently rewrites stored addresses.

**Issuance is one atomic statement, and the 60s throttle lives inside it.** The
current in-memory `Map` limiter resets on deploy and isn't shared across processes;
a read-then-write DB check has the same defect across concurrent requests. Instead,
issuing a token is a single upsert on the user's one token row that replaces
`token`, `created_at` and `expired_at` (and, when staging, the address) only when
the existing row is older than 60s, and reports back the surviving row -- nothing
replaced means throttled (429), and no mail is sent. Compare the cutoff in SQL, not
app-side, to avoid clock skew. The mail goes to the address on the row the
statement returns, so a throttled or lost race can never mail one address while
the row records another (I3).

The throttle applies to every issuance path (registration, resend, address change),
so no path can be used as a mailer for arbitrary addresses. Cost: correcting a
typo within a minute of staging is told to wait; the copy should say so rather
than reading as a failure. Do *not* copy the password-reset "bail if an active
token exists" idiom -- with a 24h expiry that blocks resends for a day.

**Consume is transactional and throws, never returns, on collision.** The consume
path runs inside `withPgPoolTransaction`, which rolls back only on throw; a caught
`23505` returned as a value would commit an aborted transaction. Shape:

```
DELETE FROM email_verification_tokens WHERE token = $1 AND expired_at >= NOW()
  RETURNING user_id, email
  -- no row -> INVALID, and the UPDATE is never issued (atomic under double-click)
UPDATE users SET email = <email returned by the DELETE>, email_verified_at = NOW(),
                 email_verified = true   -- legacy marker; removed in phase 3
  WHERE id = $1
  -- 23505 on unique_email -> throw; translate to EMAIL_TAKEN outside the transaction
```

The rollback un-deletes the token, so the link still works if the collision later
clears. On `EMAIL_TAKEN`, clear the stale pending state afterward or the user is
stuck in "pending confirmation" forever. **That cleanup keys on the exact token
value that collided, not on `user_id`:** a user who staged a new address in the
window owns a different token value on the same row, and a delete-by-user would
discard it silently. The error copy must say the address now belongs to another
account and that the user's current address is unchanged -- not the existing "save
failed / PM Mahz" copy.

The consume path is split into a client-taking function (the `isFirstStartedConvo`
seam): that is the only seam that makes the rollback contract testable.

**Staff action: grant exemption, not force-verify.** New cancan action + handler,
mirroring the change-role pair. During an incident the thing you want is "let this
person post". Stamping `email_verified_at` on an address staff never confirmed
would poison the mailer predicate -- the exact outcome the two-column split exists
to prevent.

## Fail-open and recovery when mail cannot be delivered

Two distinct failure modes, two distinct answers:

- **Mail is not configured** (`config.IS_EMAIL_CONFIGURED` false, which already
  guards `/forgot` and `/reset-password`): stamp `email_gate_exempt_at = NOW()` at
  user creation. Without this local dev is bricked -- the seed users would all be
  gated with no way to unwall them.
- **Mail is configured but delivery is failing** (SES outage, credentials revoked,
  sender suspended): registration still succeeds and lands on the wall page; the
  self-service path is resend once delivery recovers. For a sustained outage the
  operational path is a bulk exemption of accounts created in the outage window,
  by hand over `prod:ssh`, using the existing column and no deploy:

  ```sql
  UPDATE users SET email_gate_exempt_at = NOW()
    WHERE email_verified_at IS NULL AND email_gate_exempt_at IS NULL
      AND created_at BETWEEN '<outage start>' AND '<outage end>';
  ```

  This grants write access without marking anything verified, so the mailer
  predicate is untouched (constraint 2). Record the statement in the migration
  file's comments so it is findable during an incident.

## Views

- Site-wide banner in the master layout for gated users, linking to
  `/confirm-email`. This is the primary discovery mechanism given that forms are
  not hidden.
- Profile editor email panel: the input currently lives inside the omnibus form,
  so a gated user who edits it and saves would be bounced to `/confirm-email` with
  a message that reads as a non-sequitur -- the highest-traffic confusion path in
  the feature. Point the email field at `PUT /me/email`, render the pending address
  from the user's token row, expired or not (I3), as "awaiting confirmation of X",
  and update the copy that currently only promises notifications.
- Staff modkit on the profile page: a confirmation-status line alongside the
  registration IP, plus the exemption button gated on the new cancan action.
- Registration form: reword the email help text, which currently says the address
  is only used for password reset and opt-in notifications.
- New `views/confirm_email.html`.

## Rollout

There is no migration runner; production SQL is applied by hand (`prod:ssh`).
**Three phases.** Splitting the `DROP COLUMN` out is what keeps redeploying the
previous build a working rollback until phase 3: the old column is never touched
before then.

**Phase 1 -- `sql/9-email-confirmation.sql`, additive, before deploying any code.**
Add the two nullable columns (no default, so catalog-only and instant), the token
table with its unique `user_id` constraint, and the active view. Backport the same
additive objects into `sql/1-schema.sql` and the exemption stamp into
`sql/dev_seeds.sql`, keeping `email_verified` in place, so `reset-db` builds a
database phase-2 code can run against. Editing `1-schema.sql` cannot affect
production rollback: it only recreates databases from scratch.

Then backfill **in batches** by id range, committing between chunks: `email_verified`
rows get `email_verified_at = NOW()`, the rest get `email_gate_exempt_at = NOW()`,
each guarded by `IS NULL` so the batches are resumable and idempotent. A single
full-table UPDATE would contend with the `last_online_at` write that runs on every
authenticated request. `NOW()` is a grandfather stamp, not a claim about when anyone
confirmed; note it in the migration comment.

**Phase 2 -- deploy the code.** Five ordered steps: pause registration, deploy,
wait for the old build to drain, run the reconciliation sweep, re-enable
registration.

*Registration is paused for the whole of phase 2* via the existing
`REGISTRATION_ENABLED` keyval, honored by both builds without a deploy. Both builds
create accounts with `email_verified = false` and both new columns NULL, so a
registration is indistinguishable between builds by any column -- and the two need
opposite treatment (old-build signup grandfathered, new-build signup made to
confirm). Pausing empties that population, so every unstamped account the sweep
finds is unambiguously pre-rollout. Without the pause, a spam account registered
during the deploy window would receive a permanent exemption.

*The mailer keeps reading the legacy boolean throughout phase 2.* The old build
still clears `email_verified` on every address change without touching
`email_verified_at`, so from the phase-1 backfill until the sweep has run a verified
member who changes address through the old build carries a stale stamp on an
unconfirmed address. If the new build's mailer read the stamp during that window it
would send PMs to that address. Reading the boolean instead -- which the new build
dual-writes on confirmation -- keeps mail behavior identical to the old build's on
every row regardless of which build acted last, so the stale stamp is harmless
until the sweep repairs it. The mailer switches to the stamp only in the phase 3
build, after the sweep has made the two agree.

*Confirmation dual-writes the legacy boolean until phase 3.* This is the only place
the new build touches the old column. It makes the boolean a last-writer-wins
marker across the two builds: the old build clears it on every address change, the
new build sets it on every confirmation, so whichever build acted last is legible
afterward -- which is what both the phase-2 mailer and the sweep depend on.

*Once the old build is fully drained*, run the reconciliation sweep. Three kinds of
row, and collapsing any two is wrong:

```sql
-- 1. Reconcile: anyone the old build verified after their phase-1 batch.
UPDATE users SET email_verified_at = NOW()
  WHERE email_verified AND email_verified_at IS NULL;
-- 2. Repair: a stale verified stamp on an address the old build replaced.
UPDATE users SET email_verified_at = NULL,
                 email_gate_exempt_at = COALESCE(email_gate_exempt_at, NOW())
  WHERE NOT email_verified AND email_verified_at IS NOT NULL;
-- 3. Grandfather the still-unverified remainder: everything that existed while
--    registration was paused.
UPDATE users SET email_gate_exempt_at = NOW()
  WHERE email_verified_at IS NULL AND email_gate_exempt_at IS NULL
    AND created_at < '<timestamp registration was paused>';
```

All three are idempotent and re-runnable; (3) stays safe on a re-run because its
timestamp is fixed at the pause. Each is load-bearing:

- Skipping (1) would hand a verified legacy account only the exemption: it could
  still post but would drop out of the phase-3 mailer predicate -- a violation of
  constraint 2.
- (2) closes the one way the old build can corrupt the new columns' meaning. Left
  alone, the new build would treat the replaced address as confirmed forever: a
  permanent I1 violation. Clearing the stamp restores the old build's own behavior
  (it had already stopped mailing them), and the exemption keeps write access so
  grandfathering is unaffected. They can re-confirm at leisure.
- (2) is a flag comparison, not a timestamp inference. During the overlap the new
  build can confirm address B and the old build can then move the account to
  unconfirmed C; a timestamp guard would read B's post-cutover stamp as genuine and
  preserve it.

Only registration is paused; the site stays up. During the brief overlap a user who
confirms through the new build may still see the wall on requests the old build
serves; it clears when the old build drains. Acceptable.

**Phase 3 -- days later, once rollback is off the table.** Two ordered steps, both
required: first deploy a build that drops the confirmation dual-write and switches
the mailer predicate to `email_verified_at IS NOT NULL`, then apply
`sql/10-drop-email-verified.sql` (`ALTER TABLE users DROP COLUMN email_verified;`)
and remove the column from `sql/1-schema.sql`. Inverting the two steps makes every
confirmation and every PM notification throw `42703`.

## Accepted risks

- **AR1** -- because confirmation is the only writer of `users.email` (I2), an
  unverified account keeps holding its original (possibly typo'd) address under
  `unique_email` even after staging a correction, so that address stays unavailable
  to others until the account is deleted. Accepted: address squatting by
  unverified accounts is already possible today, and the alternative -- a second
  writer for `users.email` -- is the branch I2 exists to remove.
- **AR2** -- during a mail-delivery outage, accounts registered in the window
  cannot write until either delivery recovers (resend) or staff run the bulk
  exemption. Accepted: the outage is not detectable in-process without a health
  probe on SES, and automatic fail-open on send failure would let any transient
  error mint permanent exemptions.

## Implementation discretion

Deciding these differently changes no observable behavior; they are left to the
implementer, and the implementation review is the check:

- Where new queries live and which query style they use (the plan's only
  requirement is that pending-state reads hit the base table, not the view).
- Whether `getUserByEmail` survives; its only caller is the code being replaced.
- Exact mount position of the middleware, provided the ordering constraints above
  hold.
- Batch size for the phase-1 backfill.
- Which existing fetch/form idioms the wall page and resend button reuse.

## Tests

There is no HTTP harness and no test database -- the suite is pure unit tests plus
the fake-pg-client idiom (`server/db/convos.test.ts`). Three seams, all behavioral:

1. **`isEmailGateSatisfied(user)`** -- one expression, so most cases are
   tautologies; it earns its place on the guest case (`null -> true`), which pins
   the "guests are not gated" decision. Make it the only place the predicate
   exists, including the banner and wall-page conditions, so template and
   middleware can't drift.
2. **`isEmailGateExemptRoute({method, path})`** -- highest value. Assert every
   allowlisted pair passes (the regression net for the lockout audit), that safe
   methods pass, that `POST /topics/x/posts` is blocked, and critically that
   `POST /me/logout/extra` and `POST /xme/logout` are blocked -- proving exact
   match rather than `startsWith`/`includes`. Pin that methods arrive uppercase.
3. **`consumeEmailVerificationTokenTx`** via the fake client. Assert: no token row
   resolves `INVALID` *and never issues the UPDATE*; a `23505` on the UPDATE causes
   the promise to **reject** rather than resolve an error object (the rollback
   contract); `expect.stringContaining("expired_at")` on the DELETE, since
   "expired tokens are not consumable" is otherwise unreachable without a live
   database; and I1 directly -- when the DELETE returns `{user_id, email}`, the
   address bound as the UPDATE's parameter is the one the DELETE returned. The
   same test asserts the collision cleanup's parameter is the token value, not
   `user_id`.

Two properties are structurally guaranteed rather than unit-testable here, and are
checked manually below instead: one-token-per-user under concurrent issuance (the
unique `user_id` constraint plus single-statement upsert) and the rollout
reconciliation ordering (no test database).

## Verification

- `pnpm run check` and `pnpm test`.
- `pnpm run reset-db`, `pnpm run dev`. With no AWS creds set, confirm
  `IS_EMAIL_CONFIGURED` is false, seed users can post, and a newly registered user
  is exempted rather than walled.
- With `IS_EMAIL_CONFIGURED` forced true and the mailer stubbed to log the URL:
  register -> land on `/confirm-email` -> confirm the banner renders on every page
  -> attempt a reply and confirm the redirect + flash -> click the logged link ->
  confirm posting works and the banner is gone.
- With `IS_EMAIL_CONFIGURED` forced true and the mailer stubbed to throw: register
  and confirm the account lands on the wall page rather than a 500, then run the
  outage bulk-exemption statement and confirm the account can post while
  `email_verified_at` stays NULL.
- Lockout paths: while gated, confirm logout, login, forgot-password, and clearing
  the welcome-PM notification all still work.
- Resend: click twice inside 60s, expect a 429; restart the server and confirm the
  limit still holds (the current in-memory limiter does not).
- Legacy unverified account with no token row: /me/edit shows a
  send-confirmation button, clicking it mails the account address, and the link
  confirms it.
- Verified-user email change: change the address on `/me/edit`, confirm `email` and
  posting are unaffected, that the pending address renders, and that confirming
  swaps it in. Then repeat with an address already belonging to another account and
  confirm the specific error message and that pending state is cleared.
- Staff: as an admin, grant an exemption to a walled user and confirm they can post
  while `email_verified_at` stays NULL.
- Token binding under address churn: stage address A, then stage address B without
  clicking either link. Confirm exactly one token row exists for the user, that A's
  link is dead, and that clicking B's link verifies B.
- Collision cleanup does not eat a replacement: stage an address already owned by
  another account, click its link to trigger `EMAIL_TAKEN`, and -- before dismissing
  the error -- stage a different address from another tab. Confirm the second
  staging survives, still renders as pending, and its link confirms.
- Expired pending state: stage an address, hand-expire the row, and confirm the
  page still shows that address as awaiting confirmation, that the old link is
  rejected, and that resend mails the *staged* address rather than the account's
  current one.
- Phase-2 mailer: on a row with `email_verified = false` and `email_verified_at`
  set (the stale-stamp state), send a PM and confirm no notification email is
  attempted. Then on a row confirmed through the new build (`email_verified =
  true`), confirm one is.
- Rollout reconciliation, rehearsed locally against a copy of the phase-1 state:
  set one account `email_verified = true` with both new columns NULL and one
  `email_verified = false` likewise, run the sweep in order, and confirm the first
  ends up with `email_verified_at` set (still mailable) and only the second is
  exempted. Then rehearse both mixed-version orderings on the same account:
  - new build confirms address B, then the old build moves the account to
    unconfirmed address C -- the sweep must clear the stamp and exempt;
  - old build moves the account to C, then the new build confirms it -- the stamp
    must survive untouched.

  Afterward `SELECT count(*) FROM users WHERE email_verified <> (email_verified_at
  IS NOT NULL)` must be 0.

  Finally, rehearse the registration pause: confirm `POST /users` is refused while
  `REGISTRATION_ENABLED` is off, re-enable it, register a fresh account, re-run
  all three sweep statements, and confirm that account is still gated.

## Commit progress

- [x] 1. Add the email confirmation schema and grandfathering migration
- [x] 2. Require confirmation for writes with recovery and legacy mail behavior
- [x] 3. Switch PM mail to confirmation timestamps and retire the legacy flag
- [x] 4. Let unconfirmed accounts without a pending address request a confirmation link

## Implementation notes

- The phase-1 backfill is written as a `DO $$ ... $$` block that loops by id
  range with `COMMIT` between chunks (batch size 5000), rather than a hand-run
  sequence of statements. Transaction control inside `DO` requires the file to
  be run in autocommit, which is noted in the migration's comments.
- Added `email_verification_tokens__token`, a plain index on the token column.
  `reset_tokens` has no such index, but the consume path deletes by token value
  and the table has no primary key, so without it every confirmation seq-scans.
- `sql/dev_seeds.sql` stamps the exemption with a single trailing
  `UPDATE users SET email_gate_exempt_at = NOW()` instead of adding a column to
  the seed `INSERT`, so the seed rows stay readable and future seed users are
  covered automatically.
- Issuance is split into two single-statement upserts rather than one
  parameterized statement: `stageEmailVerification` sets `email =
  EXCLUDED.email`, `resendEmailVerification` leaves the stored address alone.
  Both carry the same `ON CONFLICT ... WHERE created_at < NOW() - INTERVAL '60
  seconds'` throttle, so each remains one atomic statement. Resend takes a
  fallback address used only when the user has no token row at all.
- The email panel on `/users/:slug/edit` renders only for the account owner.
  `PUT /me/email` acts on the logged-in user, so showing the panel while staff
  edit someone else's profile would stage the wrong account's address.
- `PUT /me/email` and `POST /api/verify-email` short-circuit when
  `IS_EMAIL_CONFIGURED` is false, matching how `/forgot` and `/reset-password`
  already behave. Accounts created in that state are exempt anyway, so there is
  nothing to confirm and no way to mail a link.
- Dropped `db.users.getUserByEmail` (discretion granted by the plan): its only
  caller was the replaced HMAC verification path. `email_verified` also left the
  `db.users.updateUser` whitelist for the same reason.
- The collision cleanup is a client-taking function
  (`deleteEmailVerificationTokenByToken(db, token)`) called with the pool, which
  is what makes its keying on the token value assertable with the fake-client
  idiom.
- Phase 3 removes the column from `sql/1-schema.sql` in the same commit as the
  code, rather than deferring it to match the hand-applied ordering of
  `sql/10-drop-email-verified.sql`. `reset_db.ts` runs only `1-schema.sql`
  through `4-better-notif-indexes.sql` plus the seeds -- it never runs the
  numbered migrations from 5 on -- so `9-email-confirmation.sql`, which still
  reads `email_verified` in its backfill, is unaffected, and the schema file
  cannot influence production ordering either way.
- `sql/9-email-confirmation.sql` is deliberately left referencing
  `email_verified`. It is the historical phase-1 migration and runs against a
  database that still has the column; rewriting it would falsify the record of
  what was applied.
- The profile editor's confirmation control is keyed on `email_verified_at`
  (via `needsEmailConfirmation`), not on whether a pending token row exists.
  Keying it on the pending row is what broke grandfathered accounts: they carry
  `email_gate_exempt_at` with no `email_verified_at` and no token row, so they
  are past the write gate -- which sends `GET /confirm-email` away again -- and
  the same-address short-circuit in `PUT /me/email` refuses their own address.
  With the control hidden they had no remaining path to confirm at all, and
  would have dropped out of PM mail permanently once phase 3 shipped.
  `needsEmailConfirmation` is a sibling of `isEmailGateSatisfied` in the same
  module for the same reason the plan gives for that one: it keeps the template
  and the predicate from drifting, and it makes "an exemption is not a
  confirmation" a unit-testable claim rather than a template detail.

## Follow Up

- [ ] `EMAIL_TAKEN` cleanup deletes the token row, so the next staging is a plain INSERT that bypasses the 60s throttle. Needs a real link click per cycle, so amplification is negligible; note it in the function comment or stage a tombstone instead of deleting.
- [ ] `GET /verify-email` on the logged-out branch flashes the `EMAIL_TAKEN` message on `/login`, revealing to an unauthenticated link holder that the address belongs to an account. Use a generic "could not be confirmed" message on that branch.
- [ ] The phase-2 reconciliation sweep exists only as SQL inside this plan's
      Rollout section, but `sql/9-email-confirmation.sql` and
      `sql/10-drop-email-verified.sql` both refer operators to it by name.
      Worth landing it as `sql/` file or runbook entry so it is findable from
      the migration directory during an incident.
- [ ] The edit-user resend script in `views/edit_user.html` and the wall-page
      resend script in `views/confirm_email.html` are two near-duplicate
      implementations of the same button. Worth collapsing into one shared
      snippet rather than letting the copy drift.
- [ ] `pnpm run reset-db` fails at `sql/dev_seeds.sql:205` with
      `column "latest_post_id" of relation "forums" does not exist` -- the
      column is written by triggers in `sql/3-drop-plv8.sql` but is never
      created by `sql/1-schema.sql`. Pre-existing on master, unrelated to this
      plan, but it blocks the local verification steps in ## Verification.
