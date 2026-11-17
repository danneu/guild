import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config")>()),
  ANTHROPIC_API_KEY: "test-key",
}));

import claude from "./claude";
import type { ScreeningCharge } from "../../db/screen_budget";

// Only server/db/screen_budget.ts makes a real charge; the cast stands in.
function charge(): ScreeningCharge {
  return {
    take: () => JSON.stringify({ username: "newbie", title: null, body: "hi" }),
  } as unknown as ScreeningCharge;
}

// Rejects the way fetch and its body reads do once the request's signal
// aborts, and never settles before that.
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

let signal: AbortSignal | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  signal = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("analyze", () => {
  // Intent: a call that runs past the timeout is ended, not just abandoned,
  // and reports API_TIMEOUT.
  // Why it exists: analyze raced a timer against the request, so a timed-out
  // call kept running and billing, and nothing capped how many ran
  // (hunt 261117-0852-022).
  // Scenario: the API stalls before it answers, or after its headers while
  // the body is read.
  it.each([
    [
      "the response",
      (init: RequestInit) => untilAborted(init.signal as AbortSignal),
    ],
    [
      "the body",
      async (init: RequestInit) =>
        ({
          ok: true,
          json: () => untilAborted(init.signal as AbortSignal),
        }) as unknown as Response,
    ],
  ])("aborts a request that stalls on %s", async (_label, respond) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return respond(init);
      }),
    );

    const result = claude.analyze(charge());
    await vi.runAllTimersAsync();

    expect(await result).toEqual({ ok: false, error: "API_TIMEOUT" });
    expect(signal?.aborted).toBe(true);
  });
});
