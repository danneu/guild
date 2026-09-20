// Copy and best-effort mailing for the email-confirmation routes
// (plan/2026-08-11-1613), kept out of the route module so they are unit
// testable without booting the app's require graph.

export const SEND_FAILED_MESSAGE =
  "We staged the change but could not send the email right now. Try resending in a minute.";

// Message for a confirmation link that could not be consumed because the
// address has since been claimed by another account.
//
// An unauthenticated link holder is told nothing specific: "this address
// belongs to another account" is an account-existence oracle for whoever is
// holding the link, who need not be the person it was mailed to. A logged-in
// user is looking at their own staged address, so the specific reason costs
// them nothing and is what makes the page actionable.
export function emailTakenFlashMessage(isLoggedIn: boolean): string {
  return isLoggedIn
    ? "That email address now belongs to another account, so it could not be confirmed. The address on your account is unchanged. Enter a different address to confirm."
    : "That confirmation link could not be confirmed. Request a new one after logging in.";
}

// Mailing is best-effort, exactly as it is at registration: the token row is
// already staged and correct, so a provider outage must not surface as a 500
// that makes the user think the change did not take. Returns whether the mail
// actually went out; the caller picks the copy.
export async function trySend(send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (err) {
    console.error("Failed to send email verification link", err);
    return false;
  }
}
