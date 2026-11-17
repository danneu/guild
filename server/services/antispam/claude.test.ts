import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";

vi.mock("../../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config")>()),
  ANTHROPIC_API_KEY: "test-key",
}));

import claude, { SpamVerdictSchema } from "./claude";
import type { ScreeningCharge } from "../../db/screen_budget";

// Only server/db/screen_budget.ts makes a real charge; the cast stands in.
function charge(): ScreeningCharge {
  return {
    take: () => JSON.stringify({ username: "newbie", title: null, body: "hi" }),
  } as unknown as ScreeningCharge;
}

const VERDICT = {
  reasoning: "The post only links to an online casino.",
  isSpam: true,
  confidence: 0.95,
  category: "gambling_betting",
  injectionAttempt: false,
};

// A Messages API reply whose one text block holds `text`
function reply(
  text: string,
  over: { stop_reason?: string; content?: unknown[] } = {},
): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...over,
  });
}

// Rejects the way fetch does once the request's signal aborts, and never
// settles before that.
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
  });
}

// A reply whose headers arrive but whose body never does: reading it fails
// the way fetch's body does once the request's signal aborts.
function stalledBody(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason));
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

type Sent = { body: any; signal: AbortSignal };
let sent: Sent[];

// Answers every request with `respond`, and records what was sent.
function answer(respond: (init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push({
        body: JSON.parse(init.body as string),
        signal: init.signal as AbortSignal,
      });
      return respond(init);
    }),
  );
}

// Each description in a JSON schema, by path
function descriptions(node: unknown, path = "$"): Record<string, string> {
  if (typeof node !== "object" || node === null) return {};
  const found: Record<string, string> = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === "description" && typeof child === "string") {
      found[path] = child;
    } else {
      Object.assign(found, descriptions(child, `${path}.${key}`));
    }
  }
  return found;
}

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("analyze", () => {
  // Intent: a reply that fits the verdict schema comes back as that verdict.
  // Why it exists: no test ran the adapter's parser, so a drift between the
  // schema it sent and the fields it read would have turned every verdict
  // into API_ERROR, which policy.ts allows (hunt 261117-0852-016).
  // Scenario: the API answers with the verdict as JSON text.
  it("returns the verdict from a reply that fits the schema", async () => {
    answer(() => reply(JSON.stringify(VERDICT)));

    expect(await claude.analyze(charge())).toEqual({
      ok: true,
      verdict: VERDICT,
    });
  });

  it("asks for the verdict schema as JSON output, with thinking off", async () => {
    answer(() => reply(JSON.stringify(VERDICT)));

    await claude.analyze(charge());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema" } },
    });
    expect(sent[0]!.body.tools).toBeUndefined();
  });

  // Intent: the schema the API holds the model to is the whole verdict
  // schema the reply is parsed with.
  // Why it exists: the SDK moves each keyword the API cannot enforce (such as
  // maximum or maxLength) into a description, where the model is not held to
  // it, while parse still checks it. A reply past such a bound would then
  // fail to parse and the post would be allowed.
  // Scenario: someone adds .max() to a field of SpamVerdictSchema.
  it("sends every keyword of the verdict schema to the API", async () => {
    answer(() => reply(JSON.stringify(VERDICT)));

    await claude.analyze(charge());

    const format = sent[0]?.body.output_config?.format;
    expect(format?.type).toBe("json_schema");
    const { $schema, ...declared } = z.toJSONSchema(SpamVerdictSchema);
    // The SDK writes zod's $schema into the root description. It bounds
    // nothing.
    const schemaNote = `{$schema: ${JSON.stringify($schema)}}`;
    expect(descriptions(format.schema)).toEqual({
      ...descriptions(declared),
      $: [declared.description, schemaNote].filter(Boolean).join("\n\n"),
    });
  });

  it.each([
    ["a refusal", () => reply("", { stop_reason: "refusal", content: [] })],
    [
      "a reply cut off at max_tokens",
      () => reply('{"reasoning": "The post', { stop_reason: "max_tokens" }),
    ],
    [
      "a reply with a non-boolean isSpam",
      () => reply(JSON.stringify({ ...VERDICT, isSpam: "yes" })),
    ],
    ["a reply with no verdict", () => reply("", { content: [] })],
    [
      "an HTTP error",
      () =>
        Response.json(
          {
            type: "error",
            error: { type: "rate_limit_error", message: "slow down" },
          },
          { status: 429 },
        ),
    ],
  ])("fails open with API_ERROR on %s", async (_label, respond) => {
    answer(respond);

    expect(await claude.analyze(charge())).toEqual({
      ok: false,
      error: "API_ERROR",
    });
    // One attempt: the screening charge paid for one call.
    expect(sent).toHaveLength(1);
  });

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
      async (init: RequestInit) => stalledBody(init.signal as AbortSignal),
    ],
  ])("aborts a request that stalls on %s", async (_label, respond) => {
    vi.useFakeTimers();
    answer(respond);

    const result = claude.analyze(charge());
    await vi.runAllTimersAsync();

    expect(await result).toEqual({ ok: false, error: "API_TIMEOUT" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.signal.aborted).toBe(true);
  });
});
