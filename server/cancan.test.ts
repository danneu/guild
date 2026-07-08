import { describe, expect, it } from "vitest";

import { visibleRegistrationIp } from "./cancan";

const registrationIp = "203.0.113.42";

function user(props: Record<string, unknown> = {}) {
  return {
    id: 1,
    uname: "User",
    role: "member",
    created_at: new Date("2026-07-04T00:00:00Z"),
    registration_ip: registrationIp,
    ...props,
  };
}

describe("visibleRegistrationIp", () => {
  it("hides IPs before the milestone and shows them on or after it", () => {
    const admin = user({ id: 2, role: "admin" });

    expect(
      visibleRegistrationIp(
        admin,
        user({ created_at: new Date("2026-07-03T23:59:59Z") }),
      ),
    ).toBeNull();
    expect(
      visibleRegistrationIp(
        admin,
        user({ created_at: new Date("2026-07-04T00:00:00Z") }),
      ),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(
        admin,
        user({ created_at: new Date("2026-07-04T00:00:01Z") }),
      ),
    ).toBe(registrationIp);
  });

  it("follows the READ_USER_IP down-chain hierarchy", () => {
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "admin" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "smod" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "mod" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "member" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "admin" }), user({ role: "banned" })),
    ).toBe(registrationIp);

    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "admin" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "smod" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "mod" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "member" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "smod" }), user({ role: "banned" })),
    ).toBe(registrationIp);

    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "smod" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "mod" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "member" })),
    ).toBe(registrationIp);
    expect(
      visibleRegistrationIp(user({ role: "mod" }), user({ role: "banned" })),
    ).toBe(registrationIp);

    expect(
      visibleRegistrationIp(user({ role: "member" }), user({ role: "member" })),
    ).toBeNull();
    expect(
      visibleRegistrationIp(
        user({ id: 3, role: "member" }),
        user({ id: 3, role: "member" }),
      ),
    ).toBeNull();
  });

  it("hides null registration IPs regardless of viewer or date", () => {
    expect(
      visibleRegistrationIp(
        user({ role: "admin" }),
        user({ registration_ip: null }),
      ),
    ).toBeNull();
  });
});
