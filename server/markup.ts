// The only server path into markup work: rendering BBCode into the html a row
// stores, and scanning markup for the unames it mentions or quotes. Routes and
// server/db/notifications.ts call these exports, never server/bbcode.js, and
// a test fails if any other non-test server module imports bbcode.js.
//
// Every call is bounded the same way, so no caller has to opt in:
// - markup longer than MAX_POST_LENGTH is refused before any work;
// - the work runs under a wall-clock budget, a vm timeout that cuts off even
//   a regex in the middle of its search;
// - work that runs past the budget, or runs out of stack, puts its actor in a
//   cooldown, and this module refuses that actor's markup work until it ends.
// Each refusal throws MarkupRejected. The error handler in server/index.ts
// answers an /api/ request with a 400 and the reason as text, and gives a
// form post the reason as a flash. The renderer's known slow paths are
// linear, so the budget is a backstop for shapes nobody has found yet. The
// cooldowns live in this process and clear on restart.

// Node
import assert from "assert";
import vm from "node:vm";
// 1st party
import bbcode from "./bbcode";
import * as config from "./config";
import { MarkupRejected } from "./markup_rejected";

export { MarkupRejected };

// The user whose request the work serves. Work past the budget puts this
// user in cooldown.
export type MarkupActor = { id: number };

// The author of scanned markup. The scans skip mentions of their own uname.
export type MarkupAuthor = { id: number; uname: string };

export type MarkupOwner = {
  // Returns the sanitized html to store for markup.
  renderMarkup(markup: string, actor: MarkupActor): string;
  // Returns the unique lowercase unames that markup mentions with [@uname]
  // outside any quote, at most MENTIONS_PER_POST of them.
  extractMentions(markup: string, author: MarkupAuthor): string[];
  // Returns the unique lowercase unames that quotes at the top level name,
  // as in [quote=@uname], at most MENTIONS_PER_POST of them.
  extractQuoteMentions(markup: string, author: MarkupAuthor): string[];
};

export type MarkupOwnerOptions = {
  maxLength: number;
  budgetMs: number;
  cooldownMs: number;
  render: (markup: string) => string;
  now: () => number;
};

// Builds an owner with its own cooldowns. The app uses the one below, built
// from config; tests build their own with a fake clock and render.
export function createMarkupOwner(options: MarkupOwnerOptions): MarkupOwner {
  const { maxLength, budgetMs, cooldownMs, render, now } = options;
  // User id -> the time its cooldown ends.
  const cooldowns = new Map<number, number>();

  function run<T>(markup: string, actorId: number, work: () => T): T {
    assert(typeof markup === "string", "markup must be a string");
    assert(Number.isInteger(actorId), "actor id must be an integer");
    if (markup.length > maxLength) {
      throw new MarkupRejected(
        `Text can be at most ${maxLength} characters long.`,
      );
    }
    const start = now();
    const cooldownEnd = cooldowns.get(actorId);
    if (cooldownEnd !== undefined) {
      if (cooldownEnd > start) {
        throw new MarkupRejected(
          "Your last text took too long to process. " +
            `Try again in ${minutesUntil(cooldownEnd, start)}.`,
        );
      }
      cooldowns.delete(actorId);
    }
    try {
      return runWithin(budgetMs, work);
    } catch (err) {
      if (!isTimeout(err) && !isOutOfStack(err)) throw err;
      for (const [id, end] of cooldowns) {
        if (end <= start) cooldowns.delete(id);
      }
      cooldowns.set(actorId, start + cooldownMs);
      throw new MarkupRejected(
        "This text took too long to process, so it was not saved. " +
          `Try again in ${minutesUntil(start + cooldownMs, start)}.`,
      );
    }
  }

  return {
    renderMarkup(markup, actor) {
      return run(markup, actor.id, () => render(markup));
    },
    extractMentions(markup, author) {
      return run(markup, author.id, () => scanMentions(markup, author.uname));
    },
    extractQuoteMentions(markup, author) {
      return run(markup, author.id, () =>
        scanQuoteMentions(markup, author.uname),
      );
    },
  };
}

const owner = createMarkupOwner({
  maxLength: config.MAX_POST_LENGTH,
  budgetMs: config.MARKUP_BUDGET_MS,
  cooldownMs: config.MARKUP_COOLDOWN_MS,
  render: bbcode,
  now: Date.now,
});

export const { renderMarkup, extractMentions, extractQuoteMentions } = owner;

////////////////////////////////////////////////////////////
// Budget

// A vm timeout terminates whatever JavaScript is running when it fires, so it
// also stops host code that the context calls, such as bbcode.js. One script
// and one context serve every call; work is swapped in for each run.
const budgetScript = new vm.Script("work()");
const budgetContext = vm.createContext({ work: null });

function runWithin<T>(ms: number, work: () => T): T {
  budgetContext.work = work;
  try {
    return budgetScript.runInContext(budgetContext, { timeout: ms }) as T;
  } finally {
    budgetContext.work = null;
  }
}

// These checks read the error's code and name rather than use instanceof.
// The work may come from another realm, as it does under vitest, and there
// its errors are not instances of this module's Error classes.
function isTimeout(err: unknown): boolean {
  return errorField(err, "code") === "ERR_SCRIPT_EXECUTION_TIMEOUT";
}

// V8 reports a deep call stack as a RangeError, or as a SyntaxError that ends
// in "Stack overflow" when it runs out while compiling a regex. A RangeError
// for a string or array too long to build is the same kind of exhaustion.
function isOutOfStack(err: unknown): boolean {
  const name = errorField(err, "name");
  const message = errorField(err, "message");
  return (
    name === "RangeError" ||
    (name === "SyntaxError" &&
      typeof message === "string" &&
      /Stack overflow$/.test(message))
  );
}

function errorField(err: unknown, key: string): unknown {
  return typeof err === "object" && err !== null
    ? (err as Record<string, unknown>)[key]
    : undefined;
}

function minutesUntil(end: number, from: number): string {
  const minutes = Math.max(1, Math.ceil((end - from) / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

////////////////////////////////////////////////////////////
// Scans

// A [@Mention] counts only when no quote encloses it.
function scanMentions(str: string, unameToReject: string): string[] {
  const unames = new Set<string>();
  // The quote alternative stops at [ as well as ]. When it stopped only at ],
  // each "[quote" in a run with no ] after it searched to the end of the
  // text, which took quadratic time.
  const re = /\[(quote)[^\]\[]*\]|\[(\/quote)\]|\[@([a-z0-9_\- ]+)\]/gi;
  const quoteStack: string[] = [];

  // Stop matching if we've hit notification limit for the post
  let limitRemaining = config.MENTIONS_PER_POST;
  assert(Number.isInteger(limitRemaining));

  let match: RegExpExecArray | null;
  while (limitRemaining > 0 && (match = re.exec(str))) {
    // match[1] is undefined or 'quote'
    // match[2] is undefined or '/quote'
    // match[3] is undefined or uname
    if (match[1]) {
      quoteStack.push("quote");
    } else if (match[2]) {
      quoteStack.pop();
    } else if (match[3]) {
      const uname = match[3].toLowerCase();
      if (quoteStack.length === 0 && uname !== unameToReject.toLowerCase()) {
        unames.add(uname);
        limitRemaining--;
      }
    }
  }
  return [...unames];
}

// Only quotes at the top level count, as [quote=@some user].
function scanQuoteMentions(str: string, unameToReject: string): string[] {
  const unames = new Set<string>();
  const re = /\[(quote)=?@?([a-z0-9_\- ]+)\]|\[(\/quote)\]/gi;
  const quoteStack: string[] = [];

  // Stop matching if we've hit notification limit for the post
  let limitRemaining = config.MENTIONS_PER_POST;
  assert(Number.isInteger(limitRemaining));

  let match: RegExpExecArray | null;
  while (limitRemaining > 0 && (match = re.exec(str))) {
    // match[1] is undefined or 'quote'
    // match[2] is undefined or uname
    // match[3] is undefined or '/quote'
    if (match[2]) {
      const uname = match[2].toLowerCase();
      if (quoteStack.length === 0 && uname !== unameToReject.toLowerCase()) {
        unames.add(uname);
        limitRemaining--;
      }
    }
    if (match[1]) {
      quoteStack.push("quote");
    }
    if (match[3]) {
      quoteStack.pop();
    }
  }
  return [...unames];
}
