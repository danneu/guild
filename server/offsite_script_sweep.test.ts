// Every script and stylesheet a view loads must come from the forum itself.
// Code from another site runs on the forum origin with the member's session,
// so whoever controls that site, or a redirect on the way, can post, send PMs
// and use a moderator's powers. Finding 261117-0852-061 was search and chat
// loading React through fb.me redirects to unpkg. A load passes when its URL
// resolves to the page's own origin, or when it matches a reviewed entry
// below. The sweep reads the static tags in views/, the nunjucks root, and
// those inside HTML and nunjucks comments, since an edit can uncomment them.
// A script that inline code adds at runtime is out of its reach.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");

// Same-origin values resolve against this placeholder, not HOST: a view names
// a path, since staging and dev serve at other hosts. new URL is the browser's
// own parser, so it reads //host, /\host, data: and javascript: as browsers
// do.
const BASE = new URL("https://sweep.invalid/");

// Each entry is a file and the exact attribute value it may load. A value with
// template syntax needs one, since the sweep cannot see what it prints. An
// off-site value needs one only for a live service the forum cannot serve
// itself. Entries are exact, so every new site needs its own review. A repeat
// in the same file passes, since it loads the same thing.
const REVIEWED_LOADS: ReadonlyArray<readonly [file: string, value: string]> = [
  // Names from dist/rev-manifest.json, which server/index.ts reads at boot
  ["views/layouts/master.html", "/{{ ctx.dist.css }}"],
  ["views/layouts/master.html", "/{{ ctx.dist.js }}"],
  ["views/search_results.html", "/{{ ctx.dist.search }}"],
  // Cloudflare Turnstile, the human test on login and signup
  ["views/login.html", "https://challenges.cloudflare.com/turnstile/v0/api.js"],
  [
    "views/register.html",
    "https://challenges.cloudflare.com/turnstile/v0/api.js",
  ],
  // Google AdSense
  [
    "views/macros/ads.html",
    "//pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
  ],
];

// Link types that fetch a stylesheet or a script
const LOADING_RELS = new Set(["stylesheet", "preload", "modulepreload"]);

type Scan = {
  // [file, value] for each attribute that loads code
  loads: Array<[string, string]>;
  // Tags the sweep cannot judge, described for the failure message
  unjudged: string[];
  // How many script open tags the parser saw
  scripts: number;
};

function scannedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "views"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

function hasTemplateSyntax(text: string): boolean {
  return /\{[{%#]|[}%#]\}/.test(text);
}

function scanHtml(file: string, html: string, scan: Scan): void {
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === "script") scan.scripts++;
      if (name === "base") {
        // A base element moves every relative path in the page.
        scan.unjudged.push(`${file}: <base>`);
        return;
      }
      let urlAttrs: string[];
      if (name === "script") {
        // An SVG script names its source with href.
        urlAttrs = ["src", "href", "xlink:href"];
      } else if (
        name === "link" &&
        (attribs.rel ?? "")
          .toLowerCase()
          .split(/\s+/)
          .some((rel) => LOADING_RELS.has(rel))
      ) {
        urlAttrs = ["href"];
      } else {
        return;
      }
      // A template tag among the attributes can print a source the parser
      // never sees, as in <script {% if x %}src="..."{% endif %}>.
      const names = Object.keys(attribs);
      if (names.some(hasTemplateSyntax)) {
        scan.unjudged.push(`${file}: <${name} ${names.join(" ")}>`);
        return;
      }
      for (const attr of urlAttrs) {
        const value = attribs[attr];
        if (value !== undefined) scan.loads.push([file, value.trim()]);
      }
    },
    oncomment(data) {
      scanHtml(file, data, scan);
    },
  });
  parser.write(html);
  parser.end();
}

function scanViews(): Scan & { scriptTexts: number } {
  const scan: Scan = { loads: [], unjudged: [], scripts: 0 };
  let scriptTexts = 0;
  for (const file of scannedFiles()) {
    const html = readFileSync(path.join(ROOT, file), "utf8");
    scanHtml(file, html, scan);
    scriptTexts += html.match(/<script\b/gi)?.length ?? 0;
  }
  return { ...scan, scriptTexts };
}

function fromForum(value: string): boolean {
  if (hasTemplateSyntax(value)) return false;
  try {
    return new URL(value, BASE).origin === BASE.origin;
  } catch {
    return false;
  }
}

function loadKey([file, value]: readonly [string, string]): string {
  return `${file}\0${value}`;
}

describe("offsite script sweep", () => {
  const scan = scanViews();
  const reviewed = new Set(REVIEWED_LOADS.map(loadKey));
  const found = new Set(scan.loads.map(loadKey));

  it("loads every script and stylesheet from the forum", () => {
    const offsite = scan.loads.filter(
      (load) => !fromForum(load[1]) && !reviewed.has(loadKey(load)),
    );
    expect(
      offsite,
      "Serve this code from the forum: add the package to package.json and copy or bundle it with gulp. A live service the forum cannot serve itself, or a template expression, needs a reviewed pair in REVIEWED_LOADS.",
    ).toEqual([]);
    expect(scan.unjudged, "The sweep cannot judge these tags.").toEqual([]);
  });

  // A tag the parser swallows as text, say after a script that a template
  // branch leaves unclosed, would escape the sweep.
  it("sees every script tag the views spell", () => {
    expect(scan.scripts).toBe(scan.scriptTexts);
  });

  it("lists only loads that still exist", () => {
    const stale = REVIEWED_LOADS.filter((load) => !found.has(loadKey(load)));
    expect(stale, "Remove these entries from REVIEWED_LOADS.").toEqual([]);
  });
});
