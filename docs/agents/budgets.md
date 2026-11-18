# Budgets on what a member can repeat

Read this before you add or change a write a member can repeat: a post or
an edit of one, a topic or its title, a PM or other send, a call to the
spam classifier, or any write with a per-account limit. `AGENTS.md` links
here. Uploads have their own caps; see [uploads.md](uploads.md).

## Lock order

A write that budgets or limits an account takes
`server/db/send_budget.ts#lockSender` before any other lock on that account,
or two writes can deadlock. `server/db/send_budget.ts#lockStanding` takes
lockSender first and reads the actor once.

## Per-account limits

A per-account limit is a gap between an account's writes, one live item per
window, or a cap on a count, such as the rating gap or the friend cap.

- The write it limits checks it. In one transaction, the write takes
  lockSender on the limited account first, reads what the limit counts, and
  writes only if the limit allows. Writes at once then queue on the lock, and
  each sees the ones before it.
- A route never reads a limit and then calls a separate write. Requests at
  once would all read the same old state and all pass.
- A limit on time compares with the database clock, never the app's. Read
  `clock_timestamp()` after the lock, not `now()`: `now()` is when the
  transaction began, which is stale after a wait on the lock. Stamp the new
  row with that same time.
- A refusal writes nothing. The write returns it as a result the route
  switches on, or throws an error the route catches.
- A limit on mail holds only if the mail goes out for what the write
  returned. POST /forgot mails a reset link only for a token
  `server/db/index.ts#issueResetToken` returned
  (`server/routes/password-reset.ts#sendResetMail`).
- Nothing fails if a new limit skips this.

## Sends

A send is a message a member writes to other members outside the forums.
Topics and posts are not sends.

- Each send pays a per-account budget through
  `server/db/send_budget.ts#spend`. The callers of spend in
  `server/db/index.ts` are the full set of sends.
- Each send's write function calls spend in its own transaction, before its
  insert, and sets its own cost. Routes never pass one.
- Over budget, spend throws `SendBudgetExceeded` and nothing is written. The
  route shows that as a flash.
- Only the staff welcome PM skips the budget, through the staff variant of
  `server/db/index.ts#ConvoSender`.
- A new kind of send needs the same call, and nothing fails if it is missing.

## Posts and topics

- `server/forum_text.ts` is the only way to write post text or a topic
  title: a new topic, a reply, a 0th post, an edit, a revert and a retitle.
  Its header says how each write is gated and screened.
- Only it imports the raw writes in `server/db/forum_text_writes.ts`.
  `server/write_census.test.ts` fails on any other code that inserts a post
  or topic or sets `posts.markup`, `posts.html` or `topics.title`. A new
  write of post text goes through the owner, never into `server/db/index.ts`.
- `server/db/post_gap.ts#admitPost` spaces each member's new posts and
  topics. The raw `createPost` and `createTopic` call it in their own
  transaction, after lockStanding and before the insert. A 0th post skips
  it.

## Spam screening

- A call that sends member text to the spam classifier needs a
  `ScreeningCharge`, and only `server/db/screen_budget.ts#spendScreening`
  makes one. It prices the exact payload the classifier sends and charges it
  to a per-account budget, which also paces calls per minute.
- A write that stores text to screen reads its actor once through
  lockStanding. It charges in its own transaction, before its insert, and
  returns the charge with its row.
- After the commit, `server/forum_text.ts` hands that charge to
  `server/services/antispam/index.ts#process`. A null charge means a trusted
  actor, and no call.
- Over budget, spendScreening throws `ScreeningBudgetExceeded` and nothing is
  written. It is a `MemberRefusal`, so `server/middleware/refusals.ts`
  answers it (see
  [requests-and-responses.md](requests-and-responses.md#refusals)).
- A NUKE verdict hides the actor's own rows (`nukeUser`). For a post or title
  the actor changed but does not own, the owner hides that row only while it
  still holds the judged text, and never puts back an older one.

## The classifier

- Every classifier failure fails open to ALLOW. So in production each machine
  runs `server/services/antispam/claude.ts#probe`, the one call without a
  charge, at boot and on a timer
  (`server/services/antispam/index.ts#startClassifierProbe`). It sends a
  fixed sample, and posts a Discord note when no verdict comes back.
- `SpamVerdictSchema` in `claude.ts` is both the request's output format and
  the parser of the reply. Give it only keywords the API enforces;
  `claude.test.ts` fails on any other.
