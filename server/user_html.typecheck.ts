// Compile-time checks on server/user_html.ts. tsc includes this file and
// vitest does not, so `pnpm run check` passes only while the @ts-expect-error
// below still marks a type error: a writer of a stored html column refuses
// html that did not come from sanitizeUserHtml.

import * as db from "./db";
import type { PgClientInTransaction } from "./db/util";

// A route that stores a member's text as html (hunt 261117-0852-030)
export function createPmWithStringHtml(pgClient: PgClientInTransaction) {
  return db.createPm(pgClient, {
    userId: 1,
    ipAddress: "127.0.0.1",
    convoId: 2,
    markup: "<script>alert(1)</script>",
    // @ts-expect-error -- a writer takes html only from sanitizeUserHtml
    html: "<script>alert(1)</script>",
  });
}
