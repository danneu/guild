// The error for markup the server refuses to render or scan. Its message is
// written for the member. The error handler in server/index.ts sends it to an
// /api/ request as the text of a 400, and to a form post as a flash. It has
// its own module because both server/markup.ts and server/bbcode.js throw it,
// and markup.ts imports bbcode.js.
export class MarkupRejected extends Error {
  override name = "MarkupRejected";
}
