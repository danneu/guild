import { beforeEach, describe, expect, it, vi } from "vitest";

import * as db from "../db";
import * as emailer from "../emailer";
import { sendResetMail } from "./reset-mail";

vi.mock("../db", () => ({ issueResetToken: vi.fn() }));
vi.mock("../emailer", () => ({ sendResetTokenEmail: vi.fn() }));

const user = { id: 42, uname: "Member", email: "member@example.com" };
const token = "0190e3a0-0000-7000-8000-0000000000bb";

beforeEach(() => {
  vi.clearAllMocks();
});

// Intent: POST /forgot mails a link only for a token issueResetToken
// returned, so one token lifetime sends one mail.
// Why it exists: hunt finding 261117-0852-031. Requests at once for one
// address each mailed a link.
describe("sendResetMail", () => {
  it("mails nothing when no token comes back", async () => {
    vi.mocked(db.issueResetToken).mockResolvedValue(null);

    await expect(sendResetMail(user)).resolves.toBe("ACTIVE");
    expect(emailer.sendResetTokenEmail).not.toHaveBeenCalled();
  });

  it("mails the token that came back", async () => {
    vi.mocked(db.issueResetToken).mockResolvedValue({
      user_id: user.id,
      token,
      created_at: new Date(),
      expired_at: new Date(),
    });

    await expect(sendResetMail(user)).resolves.toBe("SENT");
    expect(emailer.sendResetTokenEmail).toHaveBeenCalledWith(
      user.uname,
      user.email,
      token,
    );
  });
});
