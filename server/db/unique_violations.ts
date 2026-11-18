// Reads what a Postgres unique violation means, by the index it names. It
// imports nothing, so a test that mocks server/db/util.ts still gets it.

// Which taken outcome each unique index on a member's name or address means.
// Signup and email confirmation both read a violation through this one table,
// so a new or renamed index changes one place.
const TAKEN_BY_INDEX = {
  unique_username: "UNAME_TAKEN",
  unique_slug: "UNAME_TAKEN",
  unique_unrecyclable_slug: "UNAME_TAKEN",
  unique_email: "EMAIL_TAKEN",
} as const;

export type Taken = (typeof TAKEN_BY_INDEX)[keyof typeof TAKEN_BY_INDEX];

// The unique index a failed statement violated, or null for any other error.
// Postgres names the index in the error's constraint field.
export function violatedUniqueIndex(err: unknown): string | null {
  if (
    err instanceof Error &&
    "code" in err &&
    err.code === "23505" &&
    "constraint" in err &&
    typeof err.constraint === "string"
  ) {
    return err.constraint;
  }
  return null;
}

// The taken outcome a failed statement means, or null when it means none.
export function takenBy(err: unknown): Taken | null {
  const index = violatedUniqueIndex(err);
  if (index !== null && Object.hasOwn(TAKEN_BY_INDEX, index)) {
    return TAKEN_BY_INDEX[index as keyof typeof TAKEN_BY_INDEX];
  }
  return null;
}
