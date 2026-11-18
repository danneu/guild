# Auth, roles and bans

Read this before you touch login, signup, sessions, passwords, roles, bans,
the email gate, or a `can()` check. `AGENTS.md` links here.

## Permissions

Auth is session-based. `server/cancan.ts` holds the role-based rules; roles
(Admin, Mod, Member) gate capabilities.

- Each action declares the target it reads as a zod schema in
  `server/cancan.ts#TARGETS`.
- `can()` throws on an actor or a target that does not match. So a loader
  must select every field its actions declare, and a rule cannot compile if
  it reads a field its schema leaves out.
- `server/cancan.test.ts` fails unless every action has exactly one sweep
  row, which lists the actors it allows on each target.

## Role changes

- `server/cancan.ts#grantableRoles` is the one list of who may set which
  role. UPDATE_USER_ROLE, the role menu, and the profile edit, email gate and
  nuke rules all read it.
- Change a role only through `server/db/index.ts#updateUserRole` or
  `#unnukeUser`. Each locks the actor's and the account's rows and asks the
  rule about their live roles before it writes.
- `db.nukeUser` is checked only at its route, because the automatic nukes
  have no staff actor.

## Signup

- Make an account only through `server/db/index.ts#createUserWithSession`.
  It requires a `SignupPermit`, and only
  `server/signup_gate.ts#admitSignup` makes one. So a new account path, such
  as an OAuth signup or an admin tool, fails `pnpm run check` unless it
  passes the gate.
- The permit guards only callers of that function. Code that inserts a users
  row itself skips the gate, so do not write one.
- A permit proves that the gate ran, not that each account had its own
  solve: code that holds one can pass it again. Use it in the request that
  made it, and never keep it.
- `admitSignup` reads the `REGISTRATION_ENABLED` keyval before it asks
  Cloudflare, so a closed signup costs no call. With Turnstile unconfigured
  it admits, as local dev needs.
- Call the gate before any lookup by name or email. A route that looks up an
  email first lets a bot ask which emails have accounts without a solve.
- `server/turnstile.ts#verifyTurnstileToken` is the only call to Cloudflare.
  It returns false only when the token is not solved, and throws when it
  could not check, including when Cloudflare does not answer before its
  deadline. Signup answers a throw with "try again"; login
  (`server/auth.ts#isChallengeSolved`) counts it as unsolved. Neither admits.

## Login and passwords

- `server/auth.ts` is the only module that hashes or checks a password. A
  test fails if any other file imports bcrypt.
- `server/auth.ts#hashPassword` owns the rule for a new password. It makes
  every digest the app stores, and throws `PasswordRejected` for a password
  the rule refuses, before any bcrypt work. A route that sets a password
  checks only that the two fields match; it never measures the password
  itself. Login does not check the rule, so older passwords still work.
- Log in through `server/auth.ts#authenticate`, which never shows whether an
  account exists.
- It charges every login to an attempt budget per typed identifier and per
  network (`server/db/login_attempts.ts`) before any lookup or compare. Over
  a soft limit it asks for a Turnstile challenge, or refuses when Turnstile
  is not configured. At an identifier's hard cap it refuses even a solved
  challenge.
- After signup, change a password only through
  `server/db/index.ts#replacePasswordTx`, inside a transaction. It ends every
  grant the old password left, other sessions included, before it issues the
  new session.

## Banned and unconfirmed users

- A banned user (role `banned`) can read, and can write only through the
  allowlist in `server/middleware/require-not-banned.ts`. It refuses every
  other write before any route runs.
- A new write route that banned users should keep goes on that allowlist on
  purpose.
- That gate and the email gate pass every GET as a read. A GET that writes
  must check both itself, as the Discord join does (see
  [discord.md](discord.md)).
