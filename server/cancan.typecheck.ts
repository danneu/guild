// Compile-time checks on server/cancan.ts. tsc includes this file and vitest
// does not, so `pnpm run check` passes only while each @ts-expect-error below
// still marks a type error: cancan rejects the call or the read it annotates.

import { can, type Target } from "./cancan";

// A db.loadTopicFor row without the topic's ban list (hunt 261026-0911-022)
const topicWithoutBans = {
  id: 1,
  user_id: 2,
  forum_id: 4,
  co_gm_ids: [],
  is_roleplay: true,
  is_hidden: false,
  is_closed: false,
  latest_post_at: new Date(),
  forum: { id: 4, category_id: 2, has_tags_enabled: true },
  mods: [],
};

// Callers must pass every field the action's rule reads.
export function createPostWithoutBans() {
  const member = { id: 3, role: "member" } as const;
  // @ts-expect-error -- CREATE_POST reads banned_ids
  return can(member, "CREATE_POST", topicWithoutBans);
}

// A rule sees only the fields its action declares, so a rule that reads one
// more field fails to compile until the action's schema in
// server/cancan.ts#TARGETS declares it, and every loader then must select it.
export function createPostReadsUndeclaredField(target: Target<"CREATE_POST">) {
  // @ts-expect-error -- CREATE_POST does not declare a top-level category_id
  return target.category_id;
}
