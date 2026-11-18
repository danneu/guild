// Compile-time checks on the screening charge (server/db/screen_budget.ts).
// tsc includes this file and vitest does not, so `pnpm run check` passes only
// while each @ts-expect-error below still marks a type error: the classifier
// refuses anything but a charge that spendScreening made.

import antispam from "./index";
import claude from "./claude";

// Every public field of a charge, built by hand
const handBuilt = {
  cost: 9,
  standing: {
    id: 1,
    uname: "newbie",
    posts_count: 0,
    trusted: false,
    demoted: false,
  },
  body: "hi",
  take: () => "{}",
};

export function analyzeHandBuiltCharge() {
  // @ts-expect-error -- only spendScreening makes a ScreeningCharge
  return claude.analyze(handBuilt);
}

export function processHandBuiltCharge() {
  const actor = { id: 1, uname: "newbie", slug: "newbie" };
  // @ts-expect-error -- only spendScreening makes a ScreeningCharge
  return antispam.process(actor, handBuilt, { kind: "post", postId: 1 });
}
