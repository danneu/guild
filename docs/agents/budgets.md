# Budgets on what a member can repeat

Read this before you add or change a write a member can repeat: a post, a
topic, a PM or other send, or a call to the spam classifier. `AGENTS.md`
links here. Uploads have their own caps; see [uploads.md](uploads.md).

## Lock order

A write that budgets its actor takes `server/db/send_budget.ts#lockSender`
before any other lock on that account, or two writes can deadlock.
`server/db/send_budget.ts#lockStanding` takes lockSender first and reads the
actor once.

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

- `server/db/post_gap.ts#admitPost` spaces each member's new posts and
  topics.
- `server/db/index.ts#createPost` and `#createTopic` call admitPost in their
  own transaction, after lockStanding and before the insert.
- They are the only code that inserts posts. A test fails on any other
  `INSERT INTO posts`.

## Spam screening

- A call that sends member text to the spam classifier needs a
  `ScreeningCharge`, and only `server/db/screen_budget.ts#spendScreening`
  makes one. It prices the exact payload the classifier sends and charges it
  to a per-account budget, which also paces calls per minute.
- A write that stores text to screen reads its actor once through
  lockStanding. It charges in its own transaction, before its insert, and
  returns the charge with its row.
- The route hands that charge to
  `server/services/antispam/index.ts#process`. A null charge means a trusted
  actor, and no call.
- Over budget, spendScreening throws `ScreeningBudgetExceeded` and nothing is
  written. The error handler in `server/index.ts` answers it as it answers
  `MarkupRejected`.
- The post and topic writes in `server/db/index.ts` all charge, but not every
  route that calls them hands the charge on yet. So a paid charge does not
  mean the text was screened.

## The classifier

- Every classifier failure fails open to ALLOW. So in production each machine
  runs `server/services/antispam/claude.ts#probe`, the one call without a
  charge, at boot and on a timer
  (`server/services/antispam/index.ts#startClassifierProbe`). It sends a
  fixed sample, and posts a Discord note when no verdict comes back.
- `SpamVerdictSchema` in `claude.ts` is both the request's output format and
  the parser of the reply. Give it only keywords the API enforces;
  `claude.test.ts` fails on any other.
