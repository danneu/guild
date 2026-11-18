# Budgets on what a member can repeat

Read this before you add or change a write a member can repeat: a post or
an edit of one, a topic or its title, a PM or other send, a dice campaign,
roll or album, a bio or sig, a call to the spam classifier, or any write
with a per-account limit. Read it too before you treat new members
differently from trusted ones. `AGENTS.md` links here. Uploads have their
own caps; see [uploads.md](uploads.md).

## Standing

A member is new until they are trusted. Trusted members skip the spam
check, get the larger budgets, caps and the short post gap, and may hold a
slot in the homepage status panel (`server/db/index.ts#findLatestStatuses`).

- `server/trust.ts` alone holds the rule, as one SQL text over the member's
  live posts. Its header states the rule. Hiding a post or its topic lowers
  standing at once; `users.posts_count` never decides it.
- A write reads standing once, through
  `server/db/send_budget.ts#lockStanding`, and hands it to each gate. A query
  that lists members embeds `server/trust.ts#trustedSql`.
- Never compare `posts_count` or read `approved_at` elsewhere.
  `server/standing_sweep.test.ts` fails, apart from its reviewed list.
- A `can()` rule cannot ask `server/trust.ts`; see
  [auth.md](auth.md#permissions).

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
- After the commit, the write's caller hands that charge to
  `server/services/antispam/index.ts#process` with the subject it stored:
  `server/forum_text.ts` for post text and titles, and the route for other
  text (see [other member text](#other-member-text)). A null charge means a
  trusted actor, and no call.
- Over budget, spendScreening throws `ScreeningBudgetExceeded` and nothing is
  written. It is a `MemberRefusal`, so `server/middleware/refusals.ts`
  answers it (see
  [requests-and-responses.md](requests-and-responses.md#refusals)).
- Only a verdict on a post can NUKE or relay a first post
  (`server/services/antispam/policy.ts#decideAction`). On any other subject
  a spam verdict asks a mod to review the subject's page.
- A NUKE verdict hides the actor's own rows (`nukeUser`). For a post or title
  the actor changed but does not own, the owner hides that row only while it
  still holds the judged text, and never puts back an older one.

## Other member text

Posts and sends are not all a member can repeat, or all the text others see.

- Each kind of row a member can create over and over outside posts and sends
  pays an hourly row budget per account, through
  `server/db/row_budget.ts#admitRow`. Its kinds (`RowKind`) are the full set.
  Each kind has its own budget, so a burst of one never blocks another.
- The kind's writer calls admitRow in its own transaction, after
  lockStanding and before its insert, and stamps the row with the time it
  returns. admitRow counts the member's own rows of that kind in the
  trailing hour: the table is the ledger.
- Over budget, admitRow throws `RowBudgetExceeded`, a `MemberRefusal`, and
  nothing is written.
- A write that overwrites one value, such as a bio, a sig or an edit of a
  campaign, pays no row budget: it does not add to what the member shows.
- Member text outside the forums that other members see and that can carry
  links goes to the classifier when a new member writes it. Its db writer
  charges the screening budget and returns the charge, and the route hands
  it to `antispam.processInBackground` after the commit, with the subject's
  kind (`server/services/antispam/policy.ts#SubjectKind`) and the page where
  a mod reviews it. The callers of spendScreening outside
  `server/db/forum_text_writes.ts` are the full set.
- A new kind of row needs its own admitRow kind, and new member text that
  can carry links needs the screening hand-off. Nothing fails if either is
  missing.

## The classifier

- Every classifier failure fails open to ALLOW. So in production each machine
  runs `server/services/antispam/claude.ts#probe`, the one call without a
  charge, at boot and on a timer
  (`server/services/antispam/index.ts#startClassifierProbe`). It sends a
  fixed sample, and posts a Discord note when no verdict comes back.
- `SpamVerdictSchema` in `claude.ts` is both the request's output format and
  the parser of the reply. Give it only keywords the API enforces;
  `claude.test.ts` fails on any other.
