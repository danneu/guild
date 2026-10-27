import { describe, expect, it } from "vitest";

import { splitSearchHeadline } from "./search_headline";

const START = "\u0001";
const STOP = "\u0002";

describe("splitSearchHeadline", () => {
  it("returns one plain segment for a headline with no markers", () => {
    expect(splitSearchHeadline("hello <3 world")).toEqual([
      { text: "hello <3 world", hit: false },
    ]);
  });

  it("flags the text between a start and a stop marker as a hit", () => {
    expect(splitSearchHeadline(`a ${START}dragon${STOP}, b`)).toEqual([
      { text: "a ", hit: false },
      { text: "dragon", hit: true },
      { text: ", b", hit: false },
    ]);
  });

  it("sets and clears the hit flag instead of toggling it", () => {
    expect(
      splitSearchHeadline(`a${STOP}b ${START}c${START}d${STOP} e`),
    ).toEqual([
      { text: "a", hit: false },
      { text: "b ", hit: false },
      { text: "c", hit: true },
      { text: "d", hit: true },
      { text: " e", hit: false },
    ]);
  });

  it("returns null when the headline has no text", () => {
    expect(splitSearchHeadline("")).toBeNull();
    expect(splitSearchHeadline(undefined)).toBeNull();
    expect(splitSearchHeadline(`${START}${STOP}`)).toBeNull();
  });
});
