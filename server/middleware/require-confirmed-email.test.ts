import { describe, expect, it } from "vitest";

import {
  isEmailGateExemptRoute,
  isEmailGateSatisfied,
  needsEmailConfirmation,
} from "./require-confirmed-email";

describe("isEmailGateSatisfied", () => {
  it("does not gate guests", () => {
    expect(isEmailGateSatisfied(null)).toBe(true);
    expect(isEmailGateSatisfied(undefined)).toBe(true);
  });

  it("gates a user with neither stamp", () => {
    expect(
      isEmailGateSatisfied({
        email_verified_at: null,
        email_gate_exempt_at: null,
      }),
    ).toBe(false);
  });

  it("passes a user who confirmed an address", () => {
    expect(
      isEmailGateSatisfied({
        email_verified_at: new Date(),
        email_gate_exempt_at: null,
      }),
    ).toBe(true);
  });

  it("passes a user who is excused from the gate", () => {
    expect(
      isEmailGateSatisfied({
        email_verified_at: null,
        email_gate_exempt_at: new Date(),
      }),
    ).toBe(true);
  });
});

describe("needsEmailConfirmation", () => {
  // The case the profile editor originally got wrong: a grandfathered account
  // writes freely on its exemption but has still never confirmed an address, so
  // it must keep being offered the chance. Reading the exemption as a
  // confirmation drops it out of PM notification mail with no way back.
  it("still needs confirmation when the account is merely exempt", () => {
    expect(
      needsEmailConfirmation({
        email_verified_at: null,
        email_gate_exempt_at: new Date(),
      }),
    ).toBe(true);
  });

  it("does not need confirmation once an address was confirmed", () => {
    expect(
      needsEmailConfirmation({
        email_verified_at: new Date(),
        email_gate_exempt_at: new Date(),
      }),
    ).toBe(false);
  });

  it("needs confirmation when neither stamp is set", () => {
    expect(
      needsEmailConfirmation({
        email_verified_at: null,
        email_gate_exempt_at: null,
      }),
    ).toBe(true);
  });

  it("asks nothing of guests", () => {
    expect(needsEmailConfirmation(null)).toBe(false);
  });
});

describe("isEmailGateExemptRoute", () => {
  it("passes safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isEmailGateExemptRoute({ method, path: "/topics/x/posts" })).toBe(
        true,
      );
    }
  });

  // The regression net for the lockout audit: each of these is a route a gated
  // user needs, or one whose absence would strand them.
  it.each([
    ["POST", "/me/logout"],
    ["POST", "/sessions"],
    ["POST", "/users"],
    ["POST", "/forgot"],
    ["POST", "/reset-password"],
    ["POST", "/api/verify-email"],
    ["PUT", "/me/email"],
    ["DELETE", "/me/notifications"],
    ["DELETE", "/me/notifications/convos"],
    ["DELETE", "/api/me/notifications/42"],
  ])("passes %s %s", (method, path) => {
    expect(isEmailGateExemptRoute({ method, path })).toBe(true);
  });

  it("blocks an ordinary write", () => {
    expect(
      isEmailGateExemptRoute({ method: "POST", path: "/topics/x/posts" }),
    ).toBe(false);
  });

  // Matching must be exact, not startsWith/includes: either would let a gated
  // user reach an arbitrary route by prefixing or suffixing an allowlisted one.
  it("matches paths exactly rather than by prefix or substring", () => {
    expect(
      isEmailGateExemptRoute({ method: "POST", path: "/me/logout/extra" }),
    ).toBe(false);
    expect(
      isEmailGateExemptRoute({ method: "POST", path: "/xme/logout" }),
    ).toBe(false);
  });

  it("does not match a parameterized notification route with extra segments", () => {
    expect(
      isEmailGateExemptRoute({
        method: "DELETE",
        path: "/api/me/notifications/42/extra",
      }),
    ).toBe(false);
  });

  // Pins the caller's contract: ctx.method arrives uppercase, so nothing here
  // lowercases and a lowercase method is simply not a match.
  it("expects methods to arrive uppercase", () => {
    expect(isEmailGateExemptRoute({ method: "post", path: "/me/logout" })).toBe(
      false,
    );
    expect(isEmailGateExemptRoute({ method: "get", path: "/topics" })).toBe(
      false,
    );
  });
});
