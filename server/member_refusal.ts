// The base class of every refusal written for the member: a write refused from
// its input or the member's standing, before anything was written, with a
// message the member can act on. server/middleware/refusals.ts answers every
// subclass in one branch, so a new refusal needs no handler edit. It imports
// nothing, so the db layer and server/auth.ts can throw one without an HTTP
// import.
export class MemberRefusal extends Error {
  // Whether the answer fills the form in again from FORM_REFILL_FIELDS
  // (server/middleware/flash.ts). Off unless a subclass turns it on: long
  // markup can overflow the flash cookie, and then the member sees no reason
  // at all.
  readonly echoForm: boolean = false;
}
