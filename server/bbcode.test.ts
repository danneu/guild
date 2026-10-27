import Module from "node:module";
import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";

import * as belt from "./belt";
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
const { renderUnsanitized, tagNames } = bbcode;

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

  it.each(hostileInputs)(
    "url href keeps the checked URL for $typed",
    ({ typed, shown }) => {
      const url = `http://a.com/${typed}`;
      for (const markup of [`[url=${url}]x[/url]`, `[url]${url}[/url]`]) {
        const html = renderUnsanitized(markup);
        expect(firstElement(html, "a").attribs.href, markup).toBe(
          `http://a.com/${shown}`,
        );
      }
    },
  );

  it.each(hostileInputs)(
    "img src keeps the checked URL for $typed",
    ({ typed, shown }) => {
      const html = renderUnsanitized(`[img]http://a.com/${typed}[/img]`);
      expect(firstElement(html, "img").attribs.src).toBe(
        `http://a.com/${shown}`,
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
