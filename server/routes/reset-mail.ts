// Issues a password reset token and mails its link, for POST /forgot. Kept out
// of server/index.ts so it is unit testable without booting the app.

import * as db from "../db";
import * as emailer from "../emailer";

// What became of a reset request. ACTIVE means the account's last token is
// still good, so no mail went out.
export type ResetMailResult = "SENT" | "ACTIVE" | "SEND_FAILED";

// Mails a link only for a token db.issueResetToken returned, so one token
// lifetime sends one mail however many requests arrive at once.
export async function sendResetMail(user: {
  id: number;
  uname: string;
  email: string;
}): Promise<ResetMailResult> {
  const resetToken = await db.issueResetToken(user.id);
  if (!resetToken) return "ACTIVE";
  try {
    await emailer.sendResetTokenEmail(user.uname, user.email, resetToken.token);
  } catch {
    // sendResetTokenEmail logged it
    return "SEND_FAILED";
  }
  return "SENT";
}
