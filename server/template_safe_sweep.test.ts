// Every nunjucks-level unescape in git-tracked views/ and server/ must match a
// reviewed entry below. An unescape prints its value as HTML, so it is safe
// only when that value can never hold raw author text. Finding
// 261026-0911-002 was a search headline of raw post markup printed that way.
// The sweep sees only nunjucks: client-side sinks such as jQuery .html() and
// React's dangerouslySetInnerHTML are out of its reach.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const SELF = path.relative(ROOT, __filename);

// Unescapes a template can spell: the safe filter in either form, and any
// mention of autoescape, which turns escaping off for a whole environment.
const TEMPLATE_UNESCAPE = /\|\s*safe\b|\bfilter\s+safe\b|\bautoescape\b/g;
// Server code can also hand nunjucks a value it prints unescaped.
const SERVER_UNESCAPE = new RegExp(
  `${TEMPLATE_UNESCAPE.source}|\\bmarkSafe\\b|\\bSafeString\\b`,
  "g",
);

// Each entry is a file and the whitespace-normalized nunjucks tag (or, outside
// a tag, the source line) that unescapes there. Entries are exact, not name
// patterns, so every new site needs its own review. A repeat of an entry in
// the same file passes, since it prints the same value.
const REVIEWED_SITES: ReadonlyArray<readonly [file: string, site: string]> = [
  ["views/dice/show_campaign.html", "campaign.html | safe"],
  ["views/faq.html", "post.html | safe"],
  ["views/homepage.html", "ftopic.html | safe"],
  ["views/list_statuses.html", "status.html | safe"],
  ["views/list_trophy_groups.html", "group.description_html | safe"],
  ["views/macros/macros.html", "post.html | safe"],
  ["views/macros/macros.html", "post.legacy_html | safe"],
  ["views/macros/macros.html", "status.html | safe"],
  [
    "views/macros/macros.html",
    "user.custom_title | replaceTitleNewlines | safe",
  ],
  [
    "views/macros/macros.html",
    "user.custom_title | replaceTitleNewlinesMobile | safe",
  ],
  ["views/macros/macros.html", "user.sig_html | safe"],
  ["views/macros/macros.html", "vm.html | safe"],
  ["views/macros/verify_email.html", "errorText | dump | safe"],
  ["views/macros/verify_email.html", "label | dump | safe"],
  ["views/macros/verify_email.html", "sendingLabel | dump | safe"],
  ["views/macros/verify_email.html", "successText | dump | safe"],
  ["views/macros/verify_email.html", "throttleText | dump | safe"],
  ["views/macros/verify_email.html", "url | dump | safe"],
  ["views/me_notifications.html", "n.post.html | safe"],
  ["views/me_notifications.html", "n.vm.html | safe"],
  ["views/search_results.html", "post.html | safe"],
  ["views/search_results.html", "post.legacy_html | safe"],
  ["views/show_feedback_topic.html", "ftopic.html | safe"],
  ["views/show_post_rev.html", "rev.html | safe"],
  ["views/show_trophy.html", "trophy.description_html | safe"],
  ["views/show_trophy.html", "winner.message_html | safe"],
  ["views/show_trophy_group.html", "group.description_html | safe"],
  ["views/show_user.html", "currStatus.html | safe"],
  ["views/show_user.html", "post.html | safe"],
  ["views/show_user.html", "post.legacy_html | safe"],
  ["views/show_user.html", "status.html | safe"],
  ["views/show_user.html", "user.bio_html | safe"],
  ["views/show_user.html", "user.custom_title | replaceTitleNewlines | safe"],
  ["views/show_user_recent_topics.html", "topic.first_post.html | safe"],
  ["views/show_user_recent_topics.html", "topic.first_post.legacy_html | safe"],
  ["views/show_user_trophies.html", "trophy.message_html | safe"],
];

function scannedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "views", "server"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\0")
    .filter(
      (file) =>
        file !== SELF &&
        (file.startsWith("views/")
          ? file.endsWith(".html")
          : /\.(ts|js)$/.test(file)),
    );
}

function normalize(source: string): string {
  return source
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
}

// The nunjucks tag ({{ }} or {% %}) around `index`, or else its line.
function siteAt(text: string, index: number): string {
  const open = Math.max(
    text.lastIndexOf("{{", index),
    text.lastIndexOf("{%", index),
  );
  if (open >= 0) {
    const close = /\}\}|%\}/.exec(text.slice(open + 2));
    if (close && open + 2 + close.index > index) {
      const inner = text.slice(open + 2, open + 2 + close.index);
      return normalize(inner.replace(/^-|-$/g, ""));
    }
  }
  const lineEnd = text.indexOf("\n", index);
  return normalize(
    text.slice(
      text.lastIndexOf("\n", index) + 1,
      lineEnd < 0 ? undefined : lineEnd,
    ),
  );
}

function findSites(): Array<[string, string]> {
  const sites: Array<[string, string]> = [];
  for (const file of scannedFiles()) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const pattern = file.startsWith("server/")
      ? SERVER_UNESCAPE
      : TEMPLATE_UNESCAPE;
    for (const match of text.matchAll(pattern)) {
      sites.push([file, siteAt(text, match.index)]);
    }
  }
  return sites;
}

function siteKey([file, site]: readonly [string, string]): string {
  return `${file}\0${site}`;
}

describe("template unescape sweep", () => {
  const sites = findSites();
  const reviewed = new Set(REVIEWED_SITES.map(siteKey));
  const found = new Set(sites.map(siteKey));

  it("finds no unescape outside the reviewed list", () => {
    const unreviewed = sites.filter((site) => !reviewed.has(siteKey(site)));
    expect(
      unreviewed,
      "Each site prints its value as HTML. Prove the value can never hold raw author text, then add the pair to REVIEWED_SITES.",
    ).toEqual([]);
  });

  it("lists only sites that still exist", () => {
    const stale = REVIEWED_SITES.filter((site) => !found.has(siteKey(site)));
    expect(stale, "Remove these entries from REVIEWED_SITES.").toEqual([]);
  });
});
