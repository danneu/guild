import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as config from "./config";
import {
  MarkupRejected,
  createMarkupOwner,
  extractMentions,
  extractQuoteMentions,
} from "./markup";

// bbcode.js's server branch requires TypeScript modules that Node cannot
// resolve under vitest. These tests hand each owner its own render, and the
// scans never call the renderer.
vi.mock("./bbcode", () => ({ default: vi.fn() }));

const ROOT = path.join(__dirname, "..");

const alice = { id: 1, uname: "Alice" };
const bob = { id: 2, uname: "Bob" };

// Busy-waits for ms, then returns. The budget should cut it off long before,
// and if it does not, the test fails on its assertion after ms instead of
// hanging.
function busyFor(ms: number): string {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin
  }
  return "finished";
}

function ownerWith(render: (markup: string) => string) {
  const clock = { now: 0 };
  const owner = createMarkupOwner({
    maxLength: 10,
    budgetMs: 20,
    cooldownMs: 300_000,
    render,
    now: () => clock.now,
  });
  return { owner, clock };
}

function fast(markup: string): string {
  return `<p>${markup}</p>`;
}

// Intent: every markup call is refused over the length cap, cut off past its
// budget, and refused for the actor whose work ran long until the cooldown
// ends. Other actors and other errors are not affected.
// Why it exists: finding 261026-0911-005. One post could block the event loop
// for about 36 s, and nothing stopped its author from sending it again.
describe("markup owner", () => {
  it("refuses markup over the cap before any work", () => {
    const render = vi.fn(fast);
    const { owner } = ownerWith(render);
    expect(owner.renderMarkup("x".repeat(10), alice)).toBe(
      `<p>${"x".repeat(10)}</p>`,
    );
    expect(() => owner.renderMarkup("x".repeat(11), alice)).toThrow(
      new MarkupRejected("Text can be at most 10 characters long."),
    );
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("cuts off work past the budget and cools down only its actor", () => {
    const render = vi.fn((markup: string) =>
      markup === "slow" ? busyFor(2000) : fast(markup),
    );
    const { owner, clock } = ownerWith(render);

    expect(() => owner.renderMarkup("slow", alice)).toThrow(
      new MarkupRejected(
        "This text took too long to process, so it was not saved. " +
          "Try again in 5 minutes.",
      ),
    );
    expect(() => owner.renderMarkup("ok", alice)).toThrow(
      new MarkupRejected(
        "Your last text took too long to process. Try again in 5 minutes.",
      ),
    );
    // The scans share the cooldown, since they cost the same event loop.
    expect(() => owner.extractMentions("[@Bob]", alice)).toThrow(
      MarkupRejected,
    );
    expect(owner.renderMarkup("ok", bob)).toBe("<p>ok</p>");

    clock.now = 240_001;
    expect(() => owner.renderMarkup("ok", alice)).toThrow(
      /Try again in 1 minute\./,
    );
    clock.now = 300_000;
    expect(owner.renderMarkup("ok", alice)).toBe("<p>ok</p>");
    // One slow call, one for bob, and the last one for alice.
    expect(render).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "a deep call stack",
      () => {
        const deep = (n: number): number => deep(n + 1) + 1;
        return String(deep(0));
      },
    ],
    [
      "a string too long to build",
      () => {
        throw new RangeError("Invalid string length");
      },
    ],
    [
      "a regex that runs out of stack while compiling",
      () => {
        throw new SyntaxError(
          "Invalid regular expression: /(/: Stack overflow",
        );
      },
    ],
  ])("refuses and cools down after %s", (_name, exhaust) => {
    const { owner } = ownerWith((markup) =>
      markup === "deep" ? exhaust() : fast(markup),
    );
    expect(() => owner.renderMarkup("deep", alice)).toThrow(
      /took too long to process/,
    );
    expect(() => owner.renderMarkup("ok", alice)).toThrow(
      /Your last text took too long/,
    );
  });

  it("passes other errors through without a cooldown", () => {
    const { owner } = ownerWith((markup) => {
      if (markup === "bad") throw new TypeError("boom");
      return fast(markup);
    });
    expect(() => owner.renderMarkup("bad", alice)).toThrow(
      new TypeError("boom"),
    );
    expect(owner.renderMarkup("ok", alice)).toBe("<p>ok</p>");
  });

  // The renderer refuses nesting past its depth cap with MarkupRejected.
  it("passes the renderer's own refusal through without a cooldown", () => {
    const refusal = new MarkupRejected("Tags are nested too deep.");
    const { owner } = ownerWith((markup) => {
      if (markup === "deep") throw refusal;
      return fast(markup);
    });
    expect(() => owner.renderMarkup("deep", alice)).toThrow(refusal);
    expect(owner.renderMarkup("ok", alice)).toBe("<p>ok</p>");
  });
});

// Intent: the scans find the unames a post mentions or quotes, as they did in
// server/belt.ts, with the mention scan's quote pattern stopping at "[".
// Why it exists: finding 261026-0911-005. The quote pattern stopped only at
// "]", so a run of "[quote" with no "]" after it took 5.4 s to scan at 150k
// characters.
describe("markup scans", () => {
  const author = { id: 3, uname: "Author" };

  it("finds each mention outside quotes once, skipping the author", () => {
    expect(
      extractMentions(
        "[@Alice] [@bob] [@ALICE] [@author] [quote][@carol][/quote] [@dave]",
        author,
      ),
    ).toEqual(["alice", "bob", "dave"]);
  });

  // "[quote=" followed by "[" does not open a quote, so the mention inside
  // counts.
  it("reads [quote=[@x]] as a mention of x", () => {
    expect(extractMentions("[quote=[@x]]", author)).toEqual(["x"]);
  });

  it("stops at MENTIONS_PER_POST mentions", () => {
    const markup = Array.from(
      { length: config.MENTIONS_PER_POST + 2 },
      (_, i) => `[@u${i}]`,
    ).join(" ");
    expect(extractMentions(markup, author)).toHaveLength(
      config.MENTIONS_PER_POST,
    );
  });

  it("finds each top-level quote's uname, skipping the author", () => {
    expect(
      extractQuoteMentions(
        "[quote=@Alice]a[/quote] [quote=@author]b[/quote] " +
          "[quote=@Bob][quote=@carol]c[/quote][/quote]",
        author,
      ),
    ).toEqual(["alice", "bob"]);
  });
});

// Intent: server/markup.ts is the only server module that loads the
// renderer, so every render and scan gets the cap, the budget and the
// cooldown without opting in.
// Why it exists: finding 261026-0911-005. Routes called bbcode.js directly,
// and some had no length cap at all.
// Scenario: every git-listed server .ts and .js file other than tests,
// untracked files included, so a new file is checked before it is added.
describe("markup import check", () => {
  // An import or export from, a dynamic import, or a require.
  const specifierPattern =
    /\bimport\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|\bexport\s+[^'";]*?\sfrom\s+["']([^"']+)["']|\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  const renderer = path.join(ROOT, "server", "bbcode");

  function serverFiles(): string[] {
    const out = execFileSync(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "server",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    return [...new Set(out.split("\0"))].filter(
      (file) =>
        /\.(ts|js)$/.test(file) &&
        !file.endsWith(".test.ts") &&
        existsSync(path.join(ROOT, file)),
    );
  }

  function loadsRenderer(file: string): boolean {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    for (const match of text.matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      if (!specifier.startsWith(".")) continue;
      const target = path
        .resolve(ROOT, path.dirname(file), specifier)
        .replace(/\.(js|ts)$/, "");
      if (target === renderer) return true;
    }
    return false;
  }

  it("finds server/markup.ts as the only module that loads bbcode.js", () => {
    expect(serverFiles().filter(loadsRenderer)).toEqual(["server/markup.ts"]);
  });
});
