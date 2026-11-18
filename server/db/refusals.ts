// Errors that db writes throw for an outcome their callers expect. Each write
// that throws one returns nothing a caller reads, so a caller that forgets the
// outcome fails loudly instead of dropping it. They have their own module so a
// test that mocks server/db can still build them.

// server/db/index.ts#createFriendship: the member already has the most friends
// a member may add.
export class TooManyFriends extends Error {
  override name = "TooManyFriends";
}

// server/db/index.ts#nukeUser: the account was nuked already, by staff or by
// another screened write.
export class AlreadyNuked extends Error {
  override name = "AlreadyNuked";
}
