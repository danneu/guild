import addressparser from "nodemailer/lib/addressparser";
import { describe, expect, it } from "vitest";

describe("nodemailer's address parser", () => {
  // Intent: a mail goes to the domain after the address's last @.
  // Why it exists: hunt 261117-0852-063. server/emailer.ts hands the stored
  // address to nodemailer, whose parser picks the SES recipient. nodemailer
  // 7.0.3 read the address below as a@evil.example, so the confirmation mail
  // for a gmail.com address went to evil.example (CVE-2025-13033).
  // Scenario: a visitor signs up with a quoted @ in the local part.
  it("keeps a quoted @ inside the local part", () => {
    const parsed = addressparser('"a@evil.example x"@gmail.com');

    expect(parsed.map((a: any) => a.address.split("@").pop())).toEqual([
      "gmail.com",
    ]);
  });
});
