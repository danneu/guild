// The one gate for user html that pages print unescaped. sanitizeUserHtml is
// the only maker of a UserHtml, and every writer of a stored html column takes
// a UserHtml, so stored html can hold only what the BBCode renderer
// (server/bbcode.js) and status autolinking emit. The sanitizer also sets
// every stored link's rel and target, so no writer decides which links are
// the site's own. This module does not import bbcode.js, so code that only
// needs to clean html gets nothing from the renderer.
import sanitizeHtml from "sanitize-html";

// The status names tags.cell and tags.row in server/bbcode.js accept, each
// written as a bare class and a bb- class.
const cellStatusClasses = ["active", "success", "warning", "danger", "info"]
  .map((status) => [status, `bb-${status}`])
  .flat();

// The hosts whose links stay followed and open in place. Exact names only:
// subdomains such as img. serve uploaded files, and a subdomain rule would
// trust every host added later. Not read from config.HOST, because stored
// html outlives the environment that wrote it.
const ownLinkHosts = new Set([
  "roleplayerguild.com",
  "www.roleplayerguild.com",
]);

// Pages that print stored html are served here, so a relative href, such as
// a mention's, resolves against it as a browser would.
const linkBase = "https://www.roleplayerguild.com/";

// Sets a link's rel and target from the host the URL parser reads in its
// href, whatever its writer wrote. A link counts as the site's own only when
// that host is in ownLinkHosts; an href the parser cannot read counts as
// outside.
function setLinkRel(
  tagName: string,
  attribs: sanitizeHtml.Attributes,
): sanitizeHtml.Tag {
  const { rel: _rel, target: _target, ...rest } = attribs;
  const url = rest.href === undefined ? null : URL.parse(rest.href, linkBase);
  if (url && ownLinkHosts.has(url.hostname)) return { tagName, attribs: rest };
  return {
    tagName,
    attribs: { ...rest, rel: "nofollow noopener", target: "_blank" },
  };
}

// Lists every tag, attribute, class and style the renderer and Autolinker
// write. Anything else in the input is removed. A URL must use one of the
// allowed schemes or be relative, like the smilie and mention paths and the
// protocol-relative youtube embed.
const allowlist: sanitizeHtml.IOptions = {
  transformTags: { a: setLinkRel },
  allowedTags: [
    "a",
    "abbr",
    "blockquote",
    "br",
    "button",
    "code",
    "div",
    "font",
    "footer",
    "hr",
    "iframe",
    "img",
    "li",
    "pre",
    "span",
    "sub",
    "sup",
    "table",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  allowedAttributes: {
    a: [
      "href",
      // setLinkRel writes these two, whatever the input held.
      { name: "target", values: ["_blank"] },
      { name: "rel", multiple: true, values: ["nofollow", "noopener"] },
      // Autolinker writes the full URL here when it shortens the link text.
      "title",
    ],
    abbr: ["title"],
    button: [{ name: "type", values: ["button"] }, "data-name"],
    div: ["style"],
    font: ["color"],
    iframe: ["src", "frameborder", "width", "height", "allowfullscreen"],
    img: ["src"],
    ul: ["style"],
  },
  allowedClasses: {
    a: ["bb-mention"],
    abbr: ["bb-abbr"],
    blockquote: ["bb-quote"],
    button: ["btn", "btn-default", "btn-xs", "hider-button"],
    div: [
      "bb-center",
      "bb-h1",
      "bb-h2",
      "bb-h3",
      "bb-indent",
      "bb-justify",
      "bb-right",
      "hider-body",
      "hider-heading",
      "hider-panel",
      "table-responsive",
    ],
    hr: ["bb-hr"],
    span: ["bb-b", "bb-greentext", "bb-i", "bb-mark", "bb-s", "bb-u"],
    table: ["bb-table", "bb-table-bordered"],
    td: ["bb-td", ...cellStatusClasses],
    th: ["bb-th"],
    thead: ["bb-thead"],
    tr: ["bb-tr", ...cellStatusClasses],
    ul: ["bb-list"],
  },
  allowedStyles: {
    div: { display: [/^none$/], "white-space": [/^pre-wrap$/] },
    ul: { "white-space": [/^normal$/] },
  },
  allowedSchemes: ["http", "https", "ftp"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: true,
  allowedIframeHostnames: ["youtube.com"],
  allowIframeRelativeUrls: false,
};

// Allows every tag, attribute and scheme, but parses and serializes the same
// way as the allowlist, and sets link rel and target the same way. Comparing
// the two outputs therefore counts only what the allowlist removes, never
// re-serialization such as <br> to <br />.
const reference: sanitizeHtml.IOptions = {
  transformTags: { a: setLinkRel },
  allowedTags: false,
  allowedAttributes: false,
  allowedSchemesAppliedToAttributes: [],
  allowVulnerableTags: true,
};

// Html that passed sanitizeUserHtml. The class is not exported and its field
// is private, so no other module can make or forge one, and tsc refuses a
// string where one is due. Its text comes out only through unwrapUserHtml,
// which db writers call to bind it. Binding it any other way throws, so a
// writer that forgets to unwrap stores nothing.
class UserHtml {
  readonly #html: string;

  constructor(html: string) {
    this.#html = html;
  }

  // Checks at runtime what the type checks at compile time, for values typed
  // any, such as ctx.vals, a request body or an untyped row.
  static unwrap(value: unknown): string {
    if (typeof value !== "object" || value === null || !(#html in value)) {
      throw new TypeError(
        "unwrapUserHtml takes only html from sanitizeUserHtml, " +
          `not ${value === null ? "null" : typeof value}`,
      );
    }
    return value.#html;
  }

  // pg binds an object through its toPostgres.
  toPostgres(): never {
    throw new TypeError("Bind a UserHtml with unwrapUserHtml(html)");
  }

  toString(): never {
    throw new TypeError("Read a UserHtml with unwrapUserHtml(html)");
  }

  toJSON(): never {
    throw new TypeError("Read a UserHtml with unwrapUserHtml(html)");
  }
}

export type { UserHtml };

export function sanitizeUserHtml(html: string): UserHtml {
  return new UserHtml(sanitizeHtml(html, allowlist));
}

// The html a writer stores when a member clears a field, such as a bio or a
// signature.
export const EMPTY_USER_HTML = sanitizeUserHtml("");

// The text of html that passed sanitizeUserHtml, for a db writer to bind.
// Throws on anything else, a plain string included. Of the server's modules,
// only those in server/db call it (server/user_html.test.ts), so no route can
// turn a UserHtml back into a string for a writer that takes one. Tests and
// scripts/ may call it to compare renders.
export function unwrapUserHtml(html: UserHtml): string {
  return UserHtml.unwrap(html);
}

// True when the allowlist removes something from html. The renderer's own
// output must never trip this; server/bbcode.test.ts sweeps every tag with it.
export function sanitizerChanges(html: string): boolean {
  return sanitizeHtml(html, allowlist) !== sanitizeHtml(html, reference);
}
