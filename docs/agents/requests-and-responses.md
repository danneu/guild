# Requests and responses

Read this before you add a write route, read a request body, return JSON or
HTML outside a view, set a cookie, or compare a URL with the request's host.
`AGENTS.md` links here.

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

## HTML and JSON output

- Only `ctx.render` output goes out as HTML. Any other string or Buffer body
  with an html type, sniffed or set by hand, is sent as text/plain (see
  `server/middleware/response-edge.ts`). Build new HTML pages as views.
- JSON goes out only through `server/api_json.ts#sendJson`, which sends a
  named view listing each field a client reads. Any other body Koa would
  JSON-encode, such as a db row, answers 500 at
  `server/middleware/response-edge.ts`. `pnpm test` fails on a handler that
  stringifies a body or sets a JSON type itself. Add a view instead.

## Cookies and TLS

- Every cookie the server sets is HttpOnly and SameSite=Lax, and Secure when
  `HOST` is https, whatever options the call passes (see
  `server/cookie-policy.ts#installCookiePolicy`).
- Behind Fly, TLS ends before Node, so `ctx.secure` and `ctx.protocol` say
  http. Never decide anything on them.
