// The one rule for when a member stops counting as new. The spam check skips
// trusted members and the send budget gives them more room, so both read it
// here and cannot disagree about who is new.

export function isTrustedMember(user: {
  approved_at: Date | null;
  posts_count: number;
}): boolean {
  return Boolean(user.approved_at) || user.posts_count > 5;
}
