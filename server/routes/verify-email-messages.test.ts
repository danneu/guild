import { describe, expect, it, vi } from "vitest";

import { emailTakenFlashMessage, trySend } from "./verify-email-messages";

describe("emailTakenFlashMessage", () => {
  it("tells a logged-in user exactly why their own staged address failed", () => {
    expect(emailTakenFlashMessage(true)).toContain(
      "belongs to another account",
    );
  });

  it("does not disclose that the address belongs to an account when logged out", () => {
    const message = emailTakenFlashMessage(false);

    // The link holder is not necessarily the person it was mailed to, so the
    // logged-out copy must not be an account-existence oracle.
    expect(message).not.toContain("another account");
    expect(message).toContain("could not be confirmed");
  });
});

describe("trySend", () => {
  it("reports success when the mail goes out", async () => {
    await expect(trySend(async () => undefined)).resolves.toBe(true);
  });

  it("swallows a send failure and reports it instead of throwing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // A mailer outage must not become a 500: the token row is already staged.
    await expect(
      trySend(async () => {
        throw new Error("SES rejected credentials");
      }),
    ).resolves.toBe(false);
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});
