// The error for markup the server refuses to render or scan. It has its own
// module because both server/markup.ts and server/bbcode.js throw it, and
// markup.ts imports bbcode.js. server/middleware/refusals.ts answers it. The
// form is not echoed, since its markup is often the reason and too big for
// the flash cookie.
import { MemberRefusal } from "./member_refusal";

export class MarkupRejected extends MemberRefusal {
  override name = "MarkupRejected";
}
