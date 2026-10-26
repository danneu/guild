import { describe, expect, it } from "vitest";

import { parseCallback } from "./oauth-state";

describe("parseCallback", () => {
  const state = "issued-state";
  const code = "discord-code";

  // Same string length, different byte lengths: a plain timingSafeEqual over
  // the two strings would throw here instead of rejecting.
  const multibyte = "issued-staté";

  it.each([
    ["neither side has a state", undefined, { code }],
    ["the cookie is missing", undefined, { state, code }],
    ["the query has no state", state, { code }],
    ["the query repeats state", state, { state: [state, state], code }],
    ["the query repeats code", state, { state, code: [code, code] }],
    ["the states and the code are empty", "", { state: "", code: "" }],
    [
      "a same-length multibyte state differs",
      state,
      { state: multibyte, code },
    ],
    ["the states differ", state, { state: "other-state", code }],
    ["the states match but there is no code", state, { state }],
  ])("yields no code when %s", (_case, cookieState, query) => {
    expect(parseCallback(cookieState, query)).toEqual({ ok: false });
  });

  it("yields the code when the query state matches the cookie", () => {
    expect(parseCallback(state, { state, code })).toEqual({ ok: true, code });
  });
});
