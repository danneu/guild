# Requests and responses

Read this before you add a write route, read a request body, return JSON or
HTML outside a view, set a cookie, compare a URL with the request's host,
redirect to a target that is not a fixed path, load a script or stylesheet
in a view, or call another service. `AGENTS.md` links here.

## Cross-site writes

- `server/middleware/protect-csrf.ts` refuses a write that another site's
  page sent, before any router runs.
- SameSite=Lax does not cover the writes that need no session, such as login
  and signup, or pages on other subdomains.
- The gate takes the browser's Sec-Fetch-Site when it is sent. Otherwise it
  needs Origin (or Referer, when Origin is absent) to name the request's own
  host.
- Ask whether a URL names the request's own host only through
  `server/request_host.ts#namesRequestHost`, with the raw Host header.

## Request bodies

- `server/middleware/body.ts` is the app-wide body parser. It never parses
  multipart, and it leaves `ctx.request.body` as `{}` for a body it does not
  read.
- File uploads have their own parser; see [uploads.md](uploads.md).

## Refusals

- A refusal written for the member, decided before anything is written,
  extends `server/member_refusal.ts#MemberRefusal`. A route that lets one
  escape needs no handler of its own.
- `server/middleware/refusals.ts` answers every one in one branch: a 400 with
  the message on `/api/`, otherwise the message as a flash and a redirect
  back by the Referer.
- Koa's `ctx.back` follows the Referer only when its host is the request's
  Host, and otherwise goes to the fallback it is given, so a link from
  another site never bounces back there. `server/middleware/refusals.test.ts`
  pins it.
- The flash fills the form in again only when the refusal sets `echoForm`.
  The flash cookie holds a few kilobytes, so long markup can overflow it, and
  then the member sees no reason at all. `MarkupRejected` and
  `ScreeningBudgetExceeded` leave it off for that reason.
- A route whose form must keep a value that goes back by URL, such as the
  reset token, catches its refusal and redirects itself.

## Redirects

- `server/middleware/response-edge.ts` checks the final Location of every
  response, however it was set: `ctx.redirect`, `ctx.back`, `ctx.set`, or
  middleware. One that a browser on http or https could follow to another
  host answers 500, unless it is an https URL on the edge's `OUTSIDE_HOSTS`
  list.
- The edge judges the host against the raw Host header, never `HOST`, which
  names production on staging. `OUTSIDE_HOSTS` is for a redirect the server
  builds to another service. Add a host there for a new one.
- A target the request supplies, such as a `redirectTo` query param, passes
  `server/request_host.ts#staysOnHost` with the raw Host header. When it
  fails, redirect to the route's own default page rather than refuse: the
  write has already gone through. `staysOnHost` never allows the outside
  list, so a form cannot name those hosts either.
- Judge the target as sent. `new URL(value, base).pathname` is no check: it
  turns `/.//evil.example/x`, a path on this host, into `//evil.example/x`,
  another host.

## HTML and JSON output

- Only `ctx.render` output goes out as HTML. Any other string or Buffer body
  with an html type, sniffed or set by hand, is sent as text/plain (see
  `server/middleware/response-edge.ts`). Build new HTML pages as views.
- JSON goes out only through `server/api_json.ts#sendJson`, which sends a
  named view listing each field a client reads. Any other body Koa would
  JSON-encode, such as a db row, answers 500 at
  `server/middleware/response-edge.ts`. `pnpm test` fails on a handler that
  stringifies a body or sets a JSON type itself. Add a view instead.

## Browser code

- Every script and stylesheet a view loads comes from the forum itself.
  Code from another site runs with the member's session, so whoever controls
  that site, or a redirect on the way, can act as the member.
- `server/offsite_script_sweep.test.ts` fails on a tag in `views/` whose URL
  does not resolve to the page's own origin. A template expression, or a
  live service the forum cannot serve itself (such as Turnstile), needs an
  exact reviewed entry there.
- To use a library, add it to `package.json`. Copy its built file into
  `public/vendor/` with `gulpfile.ts#copyVendorDeps`, or import it from
  browser code in `client/`, which `gulpfile.ts#bundleSearch` bundles with
  esbuild into `public/bundle/`. `client/` has its own `tsconfig.json`, which
  `pnpm run check` also runs.
- Git does not hold the bundle. `pnpm run dev` and `pnpm start` build it
  before the server starts, so rerun `pnpm exec gulp bundleSearch` after an
  edit to `client/`. `pnpm run build` revs a copy into `dist/` like
  `all.js`, since `server/index.ts` serves `public/` with a one-year max-age.
- The sweep reads static tags only. It misses a script that inline code adds
  at runtime, and it does not read SVG files, which can carry script of their
  own.

## Calls to other services

- Every call to another service has a deadline that covers the whole call,
  retries and the body included. Without one, Node's fetch waits minutes for
  a server that stalls, and the SDKs can wait longer, so a request that
  awaits the call stays open that long.
- Call fetch only through `server/outbound.ts#fetchWithin`, which takes the
  deadline as an argument.
- A client with its own HTTP stack, such as an AWS SDK, has one owner module.
  The owner builds the client and sets the deadline on each send: an
  `abortSignal` for an AWS SDK, the client's timeout option otherwise.
- `server/parser-owners.test.ts` fails on fetch used outside
  `server/outbound.ts`, and on an SDK imported outside its owner. To add a
  client library, give it one owner and add its row there. The test cannot
  see a library it has no row for, nor a send inside an owner that leaves
  out the deadline.
- Pick each budget per service, with headroom, as a named constant in the
  owner. A call that times out may still have taken effect on the other
  side, so treat it as unclear, as `server/storage.ts` does.

## Cookies and TLS

- Every cookie the server sets is HttpOnly and SameSite=Lax, and Secure when
  `HOST` is https, whatever options the call passes (see
  `server/cookie-policy.ts#installCookiePolicy`).
- Behind Fly, TLS ends before Node, so `ctx.secure` and `ctx.protocol` say
  http. Never decide anything on them.
