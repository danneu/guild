# Auth, roles and bans

Read this before you touch login, sessions, passwords, roles, bans, the email
gate, or a `can()` check. `AGENTS.md` links here.

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

## Login and passwords

- `server/auth.ts` is the only module that hashes or checks a password. A
  test fails if any other file imports bcrypt.
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
