# User html and markup

Read this before you render BBCode, store html a member wrote, scan markup
for mentions or quotes, edit `server/bbcode.js`, or add a nunjucks unescape
such as `|safe`. `AGENTS.md` links here.

## Rendering

- Pages print stored user html with `|safe`.
- Render BBCode, and scan markup for mentions and quotes, only through the
  exports of `server/markup.ts`. A test fails if any other non-test server
  module imports `server/bbcode.js`.
- The owner refuses markup longer than `MAX_POST_LENGTH` and cuts off work
  that runs past `MARKUP_BUDGET_MS`. It then refuses that user's markup work
  for `MARKUP_COOLDOWN_MS`.
- Each refusal throws `MarkupRejected`, a `MemberRefusal`.
  `server/middleware/refusals.ts` answers an `/api/` request with a 400 and
  the reason as text, and gives a form post the reason as a flash (see
  [requests-and-responses.md](requests-and-responses.md#refusals)).

## Sanitizing

- The render ends in `server/user_html.ts#sanitizeUserHtml`. Any other code
  that stores user html calls `sanitizeUserHtml` itself, and none copies
  stored html from another row.
- The sanitizer sets the rel and target of every stored link from the host
  the URL parser reads in its href. Only a link to a host in
  `server/user_html.ts#ownLinkHosts` stays followed and opens in place. Every
  other link gets nofollow and a new tab, whatever its writer wrote.

## BBCode tags

- In `server/bbcode.js` a tag writes user text into an attribute only through
  `attrValue`, and checks a URL only through `parseSafeUrl`.
- `server/bbcode.test.ts` sweeps every tag against the sanitizer's allowlist.
  It fails any tag or shape whose render costs far more than plain text of
  the same length.
- `server/bbcode.js` is copied into `public/` by Gulp. Regenerate the copy
  with `pnpm exec gulp copyServerFiles` and commit it with the source.

## Templates

- Never print a field that can hold raw author text, such as `markup`, as
  HTML.
- Every nunjucks unescape in `views/` or `server/` needs an exact reviewed
  entry in `server/template_safe_sweep.test.ts`, which defines what counts as
  one.
