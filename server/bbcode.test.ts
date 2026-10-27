import Module from "node:module";
import vm from "node:vm";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";

import * as belt from "./belt";
import * as markupRejected from "./markup_rejected";
import * as userHtml from "./user_html";

// server/bbcode.js is CommonJS shared with the browser, and its server branch
// requires TypeScript modules by bare path. vi.mock cannot reach require(),
// and Node cannot resolve a .ts file without its extension, so this hook
// hands bbcode.js its server dependencies while it loads.
const requireFakes: Record<string, unknown> = {
  // One uname exists, so a [@name] that reaches the mention pass becomes a
  // link.
  "./cache3": { default: { get: () => new Set(["name"]) } },
  // The real sanitizer, so the export under test is the one routes call.
  "./user_html": userHtml,
  // The real class, so instanceof matches what server/markup.ts throws.
  "./markup_rejected": markupRejected,
};
const moduleInternals = Module as unknown as {
  _load: (request: string, parent: { filename?: string } | null) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = function (request, parent, ...rest) {
  if (
    parent?.filename?.endsWith("/server/bbcode.js") &&
    request in requireFakes
  ) {
    return requireFakes[request];
  }
  return originalLoad.call(this, request, parent, ...rest);
};
const { default: bbcode } = await import("./bbcode").finally(() => {
  moduleInternals._load = originalLoad;
});
const { renderUnsanitized, tagNames, MAX_TAG_DEPTH } = bbcode;
// Loaded after bbcode.js, so its import of ./bbcode reuses the module above.
const { createMarkupOwner } = await import("./markup");
const { MarkupRejected } = markupRejected;

type ParsedElement = { name: string; attribs: Record<string, string> };

// Parses html the way a browser would read its tags, with entities in
// attribute values decoded.
function parseElements(html: string): ParsedElement[] {
  const elements: ParsedElement[] = [];
  const parser = new Parser({
    onopentag(name, attribs) {
      elements.push({ name, attribs });
    },
  });
  parser.end(html);
  return elements;
}

// A hang guard for synchronous work: returns what the work threw, or
// undefined. vitest's per-test timeout cannot stop a synchronous render, so it
// would wait for a slow render to return. A vm timeout cuts the work off and
// throws "Script execution timed out".
function errorWithin(ms: number, work: () => unknown): unknown {
  try {
    vm.runInContext("work()", vm.createContext({ work }), { timeout: ms });
    return undefined;
  } catch (err) {
    return err;
  }
}

function firstElement(html: string, name: string): ParsedElement {
  const element = parseElements(html).find((el) => el.name === name);
  if (!element) throw new Error(`no <${name}> in ${html}`);
  return element;
}

// Text a member can type, and what a browser shows for it. Each one ends a
// quoted attribute value or is something a string pass after the tags
// rewrites. None holds whitespace, so each also fits in a URL path.
const hostileInputs = [
  { typed: '"onmouseover="alert(1)', shown: '"onmouseover="alert(1)' },
  { typed: "'onmouseover='alert(1)", shown: "'onmouseover='alert(1)" },
  { typed: ":bow:", shown: ":bow:" },
  { typed: "&#91;hr&#93;", shown: "[hr]" },
  { typed: "&#91;@name&#93;", shown: "[@name]" },
  { typed: "<b>&gt;", shown: "<b>>" },
];
// Inputs a URL cannot hold, so they only reach params and plain content.
const whitespaceInputs = [
  {
    typed: 'x" autofocus onfocus="alert(1)',
    shown: 'x" autofocus onfocus="alert(1)',
  },
  { typed: "a\n>b", shown: "a\n>b" },
  { typed: "a\tb", shown: "a\tb" },
];
const allInputs = [...hostileInputs, ...whitespaceInputs];

// Builds [tag=param]content[/tag], inside the parents a tag requires.
function wrap(tag: string, param: string, content: string): string {
  switch (tag) {
    case "*":
      return `[list][*${param}]${content}[/list]`;
    case "list":
      return `[list${param}][*]${content}[/list]`;
    case "table":
      return `[table${param}][row][cell]${content}[/cell][/row][/table]`;
    case "row":
      return `[table][row${param}][cell]${content}[/cell][/row][/table]`;
    case "cell":
      return `[table][row][cell${param}]${content}[/cell][/row][/table]`;
    default:
      return `[${tag}${param}]${content}[/${tag}]`;
  }
}

// Honest markup that takes every tag down its normal path.
const honestMarkup = [
  "[b]b[/b] [i]i[/i] [u]u[/u] [s]s[/s] [mark]m[/mark] [sub]1[/sub] [sup]2[/sup]",
  "[center]c[/center] [centre]c[/centre] [right]r[/right] [justify]j[/justify] [indent]i[/indent]",
  "[h1]one[/h1][h2]two[/h2][h3]three[/h3]",
  "[color=red]r[/color] [colour=#00ff00]g[/colour] [color=0000ff]b[/color]",
  "[abbr=A title]a[/abbr] [abbr]no title[/abbr]",
  "[hider=Spoiler]s[/hider] [hider]s[/hider]",
  "[quote]q[/quote] [quote=@name]q[/quote] [quote=Someone]q[/quote]",
  "[code]x < y && z[/code] [pre]  pre[/pre] [noparse][b]not bold[/b][/noparse]",
  "[list][*]one[*]two[/list]",
  "[table=bordered][row=success][cell=danger]c[/cell][cell]d[/cell][/row][row][cell]e[/cell][/row][/table]",
  "[url]example.com[/url] [url=https://www.roleplayerguild.com/x]in[/url] [url=http://example.com/a?b=1&c=2]out[/url]",
  "[img]https://example.com/a.png[/img]",
  "[youtube]https://www.youtube.com/watch?v=dQw4w9WgXcQ[/youtube]",
  "[hr] [@name] :bow: >greentext\nline\ttab http://example.com/autolinked https://www.roleplayerguild.com/internal",
  // Autolinker shortens link text past its truncate length and then writes
  // the full URL as the link's title.
  "see http://example.com/a/very/long/path/that/goes/past/forty/characters/here?b=1&c=2",
  "[bbcode]x[/bbcode]",
];

describe("bbcode", () => {
  // Intent: a quote in a tag param or URL stays inside its attribute value.
  // Why it exists: finding 261026-0911-001. tags.abbr and tags.url wrote user
  // text raw into quoted attributes, so any post could add an event handler
  // that ran for every viewer, staff included.
  // Scenario: the three payloads from the finding.
  it.each([
    '[abbr=x" onmouseover="alert(1)]hi[/abbr]',
    '[url=http://a.com/"onmouseover="alert(1)]x[/url]',
    '[url]http://a.com/"onmouseover="alert(2)[/url]',
  ])("keeps the quote in %s from adding an attribute", (markup) => {
    const names = parseElements(bbcode(markup)).flatMap((el) =>
      Object.keys(el.attribs),
    );
    expect(names).not.toContain("onmouseover");
  });

  it("strips attributes the renderer never writes from stored html", () => {
    expect(
      userHtml.sanitizeUserHtml(
        '<abbr class="bb-abbr" title="x" onmouseover="alert(1)">hi</abbr>',
      ),
    ).toBe('<abbr class="bb-abbr" title="x">hi</abbr>');
  });

  // Intent: a [url] that holds a long run of non-space characters renders in
  // time linear in its length.
  // Why it exists: finding 261026-0911-005. The userinfo group of the old URL
  // regex backtracked quadratically, so this post blocked the event loop for
  // about 36 s. A linear render takes milliseconds, far inside the guard.
  // Scenario: the finding's payload, at MAX_POST_LENGTH.
  it("renders a 150k-character [url] of colons inside the hang guard", () => {
    const markup = "[url]http://" + ":".repeat(149982) + "[/url]";
    expect(markup.length).toBe(150000);
    expect(errorWithin(2000, () => bbcode(markup))).toBeUndefined();
  });
});

// Intent: each attribute a tag writes from user input parses back to the
// value the tag meant to write.
// Why it exists: the string passes after the tags (hr, greentext, smilies,
// mentions, newlines, Autolinker) rewrote text inside attribute values, even
// in tags that escaped their input.
describe("bbcode attribute values", () => {
  it.each(allInputs)("abbr title shows $typed as typed", ({ typed, shown }) => {
    const html = renderUnsanitized(`[abbr=${typed}]x[/abbr]`);
    expect(firstElement(html, "abbr").attribs.title).toBe(shown);
  });

  it.each(allInputs)(
    "hider data-name shows $typed as typed",
    ({ typed, shown }) => {
      const html = renderUnsanitized(`[hider=${typed}]x[/hider]`);
      expect(firstElement(html, "button").attribs["data-name"]).toBe(shown);
    },
  );

  // The href is the URL parser's href, which percent-encodes some
  // characters, such as a quote. So both sides go through the parser.
  it.each(hostileInputs)(
    "url href points at the typed URL for $typed",
    ({ typed, shown }) => {
      const url = `http://a.com/${typed}`;
      for (const markup of [`[url=${url}]x[/url]`, `[url]${url}[/url]`]) {
        const html = renderUnsanitized(markup);
        expect(
          new URL(firstElement(html, "a").attribs.href!).href,
          markup,
        ).toBe(new URL(`http://a.com/${shown}`).href);
      }
    },
  );

  it.each(hostileInputs)(
    "img src points at the typed URL for $typed",
    ({ typed, shown }) => {
      const html = renderUnsanitized(`[img]http://a.com/${typed}[/img]`);
      expect(new URL(firstElement(html, "img").attribs.src!).href).toBe(
        new URL(`http://a.com/${shown}`).href,
      );
    },
  );

  it("embeds a youtube id and nothing else", () => {
    const html = renderUnsanitized(
      "[youtube]https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10[/youtube]",
    );
    expect(firstElement(html, "iframe").attribs.src).toBe(
      "//youtube.com/embed/dQw4w9WgXcQ?theme=dark",
    );
  });

  // The 11 characters after youtu.be/ are a quote-led payload.
  it("rejects a youtube id that is not 11 id characters", () => {
    const html = renderUnsanitized(
      '[youtube]https://youtu.be/a"onload="x[/youtube]',
    );
    expect(parseElements(html).map((el) => el.name)).not.toContain("iframe");
  });
});

// Intent: every tag's output, for honest and hostile input alike, is html the
// stored-html allowlist keeps whole, with no attribute placeholder left over.
// Why it exists: the browser preview renders with no sanitizer behind it, so
// a tag that writes an attribute by hand, or a new string pass that reaches
// one, shows here first.
describe("bbcode sweep", () => {
  it.each(tagNames)("[%s] output passes the allowlist unchanged", (tag) => {
    for (const { typed } of allInputs) {
      for (const markup of [
        wrap(tag, `=${typed}`, "x"),
        wrap(tag, "", typed),
        wrap(tag, `=http://a.com/${typed}`, "x"),
        wrap(tag, "", `http://a.com/${typed}`),
        // Long enough that Autolinker also writes the URL into a title.
        wrap(
          tag,
          "",
          `http://a.com/long/enough/to/pass/the/forty/limit/${typed}`,
        ),
      ]) {
        const raw = renderUnsanitized(markup);
        expect(raw, markup).not.toContain("\u0000");
        expect(userHtml.sanitizerChanges(raw), `${markup}\n${raw}`).toBe(false);
      }
    }
  });

  it.each([
    "[url][img]http://a.com/a.png[/img][/url]",
    "[img][abbr=x]http://a.com/a.png[/abbr][/img]",
    "[url=http://a.com/][abbr=:bow:]x[/abbr][/url]",
    "[hider=:bow:][url=http://a.com/:bow:]x[/url][/hider]",
    "[youtube][abbr=x]https://youtu.be/dQw4w9WgXcQ[/abbr][/youtube]",
  ])("nested %s passes the allowlist unchanged", (markup) => {
    const raw = renderUnsanitized(markup);
    expect(raw).not.toContain("\u0000");
    expect(userHtml.sanitizerChanges(raw), raw).toBe(false);
  });

  it.each(honestMarkup)(
    "honest %s passes the allowlist unchanged",
    (markup) => {
      const raw = renderUnsanitized(markup);
      expect(userHtml.sanitizerChanges(raw), raw).toBe(false);
    },
  );

  // The URL is long enough that Autolinker shortens its text and adds a title.
  it("a status's autolinked text passes the allowlist unchanged", () => {
    const html = belt.autolink(
      belt.escapeHtml(
        "hi <you> & 'me' http://example.com/a/very/long/status/path?b=1&c=2",
      ),
    );
    expect(userHtml.sanitizerChanges(html), html).toBe(false);
  });
});

// Intent: [url] and [img] link only to absolute http, https and ftp URLs on
// public hosts, and write the URL parser's href.
// Why it exists: finding 261026-0911-005 replaced the URL regex with the
// WHATWG parser and host rules. The parser also reads forms the regex never
// matched, such as hex IPv4 hosts, so the private-address rules must see the
// parsed host.
describe("bbcode URL check", () => {
  // [img] hands its text straight to the check, and writes an empty src
  // when the check refuses it.
  function imgSrc(url: string): string | undefined {
    const html = renderUnsanitized(`[img]${url}[/img]`);
    return firstElement(html, "img").attribs.src || undefined;
  }

  // The href of the link tags.url writes around the text "x". A refused
  // [url] stays text, which Autolinker may still link, so only a link
  // around "x" counts.
  function urlTagHref(url: string): string | undefined {
    let href: string | undefined;
    let open: string | undefined;
    let text = "";
    const parser = new Parser({
      onopentag(name, attribs) {
        if (name === "a") [open, text] = [attribs.href, ""];
      },
      ontext(chunk) {
        text += chunk;
      },
      onclosetag(name) {
        if (name === "a" && text === "x") href = open;
      },
    });
    parser.end(renderUnsanitized(`[url=${url}]x[/url]`));
    return href;
  }

  it.each([
    ["http://example.com", "http://example.com/"],
    ["https://WWW.Example.COM/a?b=1", "https://www.example.com/a?b=1"],
    ["ftp://example.com/f.txt", "ftp://example.com/f.txt"],
    ["http://8.8.8.8/", "http://8.8.8.8/"],
    ["http://user:pass@example.com/", "http://user:pass@example.com/"],
    ["http://bücher.de/", "http://xn--bcher-kva.de/"],
    ["http://xn--80ak6aa92e.xn--p1ai/", "http://xn--80ak6aa92e.xn--p1ai/"],
    ["http://example.com:8080/a", "http://example.com:8080/a"],
  ])("links %s as %s", (url, href) => {
    expect(imgSrc(url)).toBe(href);
    expect(urlTagHref(url)).toBe(href);
  });

  it("reads an uppercase scheme in [img]", () => {
    expect(imgSrc("HTTPS://example.com/")).toBe("https://example.com/");
  });

  // tags.url adds http:// to text that does not start with http or ftp://.
  it("adds http:// to a [url] with no scheme", () => {
    expect(urlTagHref("example.com/a")).toBe("http://example.com/a");
  });

  it.each([
    "http://10.0.0.1/",
    "http://127.0.0.1/",
    "http://0x7f.1/",
    "http://2130706433/",
    "http://169.254.1.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://0.1.2.3/",
    "http://224.0.0.1/",
    "http://8.8.8.0/",
    "http://8.8.8.255/",
    "http://[::1]/",
    "http://localhost/",
    "http://a_b.com/",
    "http://-a.com/",
    "http://example.c/",
    "http://example.com./",
    `http://${"a".repeat(64)}.com/`,
    "http://example.com:99999/",
    "http://exa mple.com/",
    "http://example.com/a\tb",
    "http:example.com",
    "http:/example.com",
  ])("refuses %s", (url) => {
    expect(imgSrc(url)).toBeUndefined();
    expect(urlTagHref(url)).toBeUndefined();
  });

  it.each(["javascript:alert(1)", "mailto:a@example.com", "//example.com/"])(
    "refuses %s in [img]",
    (url) => {
      expect(imgSrc(url)).toBeUndefined();
    },
  );
});

// Intent: tags may nest MAX_TAG_DEPTH levels deep, and the server refuses
// deeper nesting with a message for the member.
// Why it exists: finding 261026-0911-005. Each level of nesting cost the
// renderer another pass over the text, and deep nesting ran out of stack,
// so one post could take seconds or throw a 500.
describe("bbcode nesting", () => {
  function nested(depth: number): string {
    return "[b]".repeat(depth) + "x" + "[/b]".repeat(depth);
  }

  it("renders tags nested MAX_TAG_DEPTH deep", () => {
    const names = parseElements(bbcode(nested(MAX_TAG_DEPTH))).map(
      (el) => el.name,
    );
    expect(names.filter((name) => name === "span")).toHaveLength(MAX_TAG_DEPTH);
  });

  it("refuses tags nested one level deeper", () => {
    expect(() => bbcode(nested(MAX_TAG_DEPTH + 1))).toThrow(MarkupRejected);
    expect(() => bbcode(nested(MAX_TAG_DEPTH + 1))).toThrow(/nested more/);
  });
});

// Intent: [list] items close as they always have, now in one pass.
// Why it exists: finding 261026-0911-005 rewrote the [*] pass, which
// rescanned the list once per item. Each expected output is what the old
// pass gave.
describe("bbcode lists", () => {
  const list = '<ul class="bb-list" style="white-space: normal;">';
  it.each([
    ["[list][*]a[*]b[/list]", `${list}<li>a</li><li>b</li></ul>`],
    [
      "[list][*]a[list][*]b[/list][*]c[/list]",
      `${list}<li>a${list}<li>b</li></ul></li><li>c</li></ul>`,
    ],
    // A [*] followed by a [* x] never closes, so the list stays text.
    ["[list][*]a[* x]b[*]c[/list]", "[list][*]a[* x]b<li>c</li>[/list]"],
    // An unpaired [list] keeps the > that marked it.
    ["[list][*]a", ">list][*]a"],
  ])("renders %s", (markup, html) => {
    expect(renderUnsanitized(markup)).toBe(
      `<div style="white-space:pre-wrap;">${html}</div>`,
    );
  });
});

// Intent: no tag and no known hostile shape costs much more to render, or to
// scan for mentions, than plain text of the same length.
// Why it exists: finding 261026-0911-005. The URL regex, the [*] pass, the
// nesting passes, the tag-param and [code] searches and the mention scan
// each took quadratic time on some shape, so one post at MAX_POST_LENGTH
// could block the event loop for seconds.
// Scenario: each shape fills MAX_POST_LENGTH and runs through an owner whose
// budget is a fixed multiple of a plain-text render's time. A quadratic
// shape runs into that budget and fails at once.
describe("bbcode render cost sweep", () => {
  const maxLength = 150000;
  const fill = (unit: string, length = maxLength) =>
    unit.repeat(Math.floor(length / unit.length));

  // How many times a plain-text render's time a shape may take. The
  // heaviest linear shapes write tens of thousands of elements, which the
  // sanitizer then reads, and take about 30 times as long as plain text. The
  // quadratic shapes this finding fixed took over a second at this length,
  // about 100 times as long or more.
  const costMultiple = 60;

  function ownerWithin(budgetMs: number) {
    return createMarkupOwner({
      maxLength,
      budgetMs,
      cooldownMs: 0,
      render: bbcode,
      now: Date.now,
    });
  }

  function msFor(work: () => unknown): number {
    const start = performance.now();
    work();
    return performance.now() - start;
  }

  const plain = fill("Some plain prose, the kind most posts hold. ");
  const author = { id: 1, uname: "author" };
  const unbounded = ownerWithin(60_000);
  // Compiles the render path, so the first shape's plain timing is warm.
  for (let i = 0; i < 3; i++) unbounded.renderMarkup(plain, author);

  // The levels one wrap() adds, so a shape can nest right up to the cap.
  function nestedToCap(tag: string): string {
    const levels = (wrap(tag, "", "x").match(/\[[^/\]]/g) || []).length;
    let markup = "x";
    for (let i = 0; i < Math.floor(MAX_TAG_DEPTH / levels); i++) {
      markup = wrap(tag, "", markup);
    }
    return markup;
  }

  const shapes: [string, string][] = [
    ["plain", plain],
    ["a [*] run", "[list]" + fill("[*]", maxLength - 13) + "[/list]"],
    ["a [*]x run", "[list]" + fill("[*]x", maxLength - 13) + "[/list]"],
    ["a [quote run", fill("[quote")],
    ["a [quote= run", fill("[quote=@")],
    ["a [@ run", fill("[@")],
    ["a [@name run", "[@" + fill("a ", maxLength - 2)],
    ["a [ run", fill("[")],
    ["a [/ run", fill("[/")],
  ];
  for (const tag of tagNames) {
    const inside = (run: string) => {
      const shell = wrap(tag, "", "");
      return wrap(tag, "", fill(run, maxLength - shell.length));
    };
    shapes.push(
      [`[${tag}] around colons`, inside("http://" + ":".repeat(64))],
      [`[${tag}] around letters`, inside("a")],
      [`[${tag}] around [`, inside("[")],
      [`unclosed [${tag}] opens`, fill(`[${tag}]`)],
      [`unclosed [${tag}= opens`, fill(`[${tag}=`)],
      [`[${tag}] nested to the cap`, fill(nestedToCap(tag))],
    );
  }

  it.each(shapes)(
    "%s stays within the budget",
    (_name, markup) => {
      expect(markup.length).toBeLessThanOrEqual(maxLength);
      // A timing can lose to a pause the shape did not cause, so a shape
      // passes when any of three runs fits.
      let rejected: unknown;
      let budgetMs = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        // Plain text is timed right before the shape, so when other work
        // slows the machine partway through the suite, the budget grows too.
        // The faster of two runs leaves out a first run's compile time.
        const plainMs = Math.min(
          msFor(() => unbounded.renderMarkup(plain, author)),
          msFor(() => unbounded.renderMarkup(plain, author)),
        );
        budgetMs = Math.max(50, Math.ceil(costMultiple * plainMs));
        const owner = ownerWithin(budgetMs);
        try {
          owner.renderMarkup(markup, author);
          owner.extractMentions(markup, author);
          owner.extractQuoteMentions(markup, author);
          return;
        } catch (err) {
          rejected = err;
        }
      }
      expect(rejected, `budget ${budgetMs} ms`).toBeUndefined();
      // The budget cuts off each run, as vitest cannot stop a synchronous
      // test. This timeout only keeps vitest from reporting its own timeout
      // in place of the budget failure when three runs fail.
    },
    60_000,
  );
});
