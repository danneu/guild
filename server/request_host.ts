// The one answer to "does this URL name the host this request came to". The
// CSRF gate's fallback asks it of Origin and Referer, and any rule about a
// request-supplied URL asks it too, so they cannot disagree on case, default
// ports, IPv6 or a bad Host. Rules about stored html have no request Host and
// keep their own fixed host list.

// A bare host and optional port: an IPv6 literal in brackets, or a name or
// IPv4 address made of RFC 3986 unreserved characters. The URL parser
// forgives what a Host header must not hold: it reads userinfo and paths,
// strips tabs, and decodes percent escapes. So the raw value must match this
// before it is parsed.
const HOST_HEADER = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~-]+)(?::[0-9]*)?$/;

// True when `url` is http or https and its host and port are the ones in
// `hostHeader`, the raw Host header. Never pass ctx.host: it reads
// X-Forwarded-Host when app.proxy is set, and keeps the first of several
// comma-separated values. The Host is parsed under the URL's own scheme, so a
// default port counts as no port on both sides. Scheme is not compared: TLS
// ends before Node, so the Host cannot say which one the browser used.
export function namesRequestHost(
  url: URL,
  hostHeader: string | undefined,
): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!hostHeader || !HOST_HEADER.test(hostHeader)) return false;
  const base = `${url.protocol}//${hostHeader}`;
  if (!URL.canParse(base)) return false;
  return new URL(base).host === url.host;
}

// True when a browser that sent this request would follow `value`, as a
// Location, to the host in `hostHeader`, the raw Host header. The value is
// resolved under both schemes, since TLS ends before Node and the browser may
// have used either: "http:evil.example" stays here from an http page but
// leaves from an https one. The URL parser is the browser's own, so
// backslashes, tabs and dot segments need no rule here. Routes ask this of a
// return target the request supplies; an empty one names no target.
export function staysOnHost(
  value: unknown,
  hostHeader: string | undefined,
): value is string {
  if (typeof value !== "string" || value === "") return false;
  return ["http:", "https:"].every((scheme) => {
    const base = `${scheme}//${hostHeader}`;
    if (!URL.canParse(value, base)) return false;
    return namesRequestHost(new URL(value, base), hostHeader);
  });
}
