// Owns the marker protocol between the search query's ts_headline and the
// search results page. ts_headline runs over the raw markup the author typed,
// so its output must never reach the page as HTML. Instead it marks each match
// with control characters, and the page prints the pieces between them as
// escaped text (views/macros/search_headline.html).

import type { Knex } from "knex";

// ts_headline puts `start` before each match and `stop` after it. The select
// strips both from the markup first, so every marker in a headline came from
// ts_headline.
const MARKERS = { start: "\u0001", stop: "\u0002" } as const;
const MARKER_SPLIT = new RegExp(`([${MARKERS.start}${MARKERS.stop}])`);

export type HeadlineSegment = { text: string; hit: boolean };

/**
 * Builds the headline select here, beside the splitter, so the markers it
 * asks ts_headline for are the ones splitSearchHeadline reads.
 */
export function searchHeadlineSql(
  knex: Knex,
  markupColumn: string,
  term: string,
): Knex.Raw {
  return knex.raw(
    `ts_headline('english', translate(??, ?, ''), plainto_tsquery('english', ?), ?)`,
    [
      markupColumn,
      MARKERS.start + MARKERS.stop,
      term,
      `StartSel=${MARKERS.start}, StopSel=${MARKERS.stop}`,
    ],
  );
}

/**
 * Splits a headline from searchHeadlineSql into text segments, each flagged
 * as a match or not. A start marker sets the flag and a stop marker clears
 * it; they never toggle, so a stray marker cannot invert the bold. Returns
 * null when there is no text, because the template tests the result for
 * truthiness and an empty list is truthy in nunjucks.
 */
export function splitSearchHeadline(
  headline: string | null | undefined,
): HeadlineSegment[] | null {
  const segments: HeadlineSegment[] = [];
  let hit = false;
  for (const part of (headline ?? "").split(MARKER_SPLIT)) {
    if (part === MARKERS.start) {
      hit = true;
    } else if (part === MARKERS.stop) {
      hit = false;
    } else if (part !== "") {
      segments.push({ text: part, hit });
    }
  }
  return segments.length > 0 ? segments : null;
}
