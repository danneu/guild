import { describe, expect, it } from "vitest";

import { presentUserForApi } from "./presenters";

const registrationIp = "203.0.113.42";

function user(props: Record<string, unknown> = {}) {
  return {
    id: 1,
    uname: "User",
    slug: "user",
    role: "member",
    email: "user@example.test",
    digest: "secret",
    eflags: 123,
    created_at: new Date("2026-07-04T00:00:00Z"),
    last_online_at: new Date("2026-07-05T00:00:00Z"),
    avatar_url: "https://example.test/avatar.png",
    custom_title: "Custom",
    posts_count: 12,
    is_nuked: false,
    registration_ip: registrationIp,
    ...props,
  } as any;
}

describe("presentUserForApi", () => {
  it("returns only whitelisted user fields", () => {
    const presented = presentUserForApi(user(), user({ id: 2, role: "admin" }));

    expect(presented).toEqual({
      id: 1,
      uname: "User",
      slug: "user",
      role: "member",
      url: "/users/user",
      created_at: new Date("2026-07-04T00:00:00Z"),
      last_online_at: new Date("2026-07-05T00:00:00Z"),
      avatar_url: "https://example.test/avatar.png",
      custom_title: "Custom",
      posts_count: 12,
      is_nuked: false,
      registration_ip: registrationIp,
      registration_ip_category: null,
    });
    expect(presented).not.toHaveProperty("email");
    expect(presented).not.toHaveProperty("digest");
    expect(presented).not.toHaveProperty("eflags");
  });

  it("gates registration IP visibility by viewer and milestone", () => {
    expect(
      presentUserForApi(user(), user({ id: 2, role: "admin" })).registration_ip,
    ).toBe(registrationIp);
    expect(
      presentUserForApi(user(), user({ id: 2, role: "member" }))
        .registration_ip,
    ).toBeNull();
    expect(
      presentUserForApi(
        user({ created_at: new Date("2026-07-03T23:59:59Z") }),
        user({ id: 2, role: "admin" }),
      ).registration_ip,
    ).toBeNull();
  });

  it("annotates a Cloudflare egress IP for staff", () => {
    const presented = presentUserForApi(
      user({ registration_ip: "104.28.203.54" }),
      user({ id: 2, role: "admin" }),
    );
    expect(presented.registration_ip).toBe("104.28.203.54");
    expect(presented.registration_ip_category).toBe("cloudflare_egress");
  });

  it("hides the note whenever the IP is hidden", () => {
    // Member viewer: IP gated off, so the note must be null too.
    const forMember = presentUserForApi(
      user({ registration_ip: "104.28.203.54" }),
      user({ id: 2, role: "member" }),
    );
    expect(forMember.registration_ip).toBeNull();
    expect(forMember.registration_ip_category).toBeNull();

    // Pre-milestone user: IP gated off, note null.
    const preMilestone = presentUserForApi(
      user({
        registration_ip: "104.28.203.54",
        created_at: new Date("2026-07-03T23:59:59Z"),
      }),
      user({ id: 2, role: "admin" }),
    );
    expect(preMilestone.registration_ip).toBeNull();
    expect(preMilestone.registration_ip_category).toBeNull();
  });
});
