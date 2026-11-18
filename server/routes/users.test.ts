import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as avatar from "../avatar";
import * as cancan from "../cancan";
import * as db from "../db";
import { withPgPoolTransaction } from "../db/util";
import * as storage from "../storage";
import { VmParentRefused } from "../db/vms";
import { UnsupportedImage } from "../imaging";
import { withUpload } from "../upload";
import "../validation";
import router from "./users";

// Spied, so a test can tell whether a request reached the upload parser.
vi.mock("../upload", { spy: true });

// Importing server/cache3.ts starts its interval cache. server/bbcode.js
// requires it outside vitest's module graph, so bbcode is stubbed too. get
// and set stand in for the uname-set that signup adds to.
vi.mock("../cache3", () => ({
  default: { get: vi.fn(() => new Set()), set: vi.fn() },
}));
vi.mock("../bbcode", () => ({ default: vi.fn() }));
// Signup's gate admits. It reads the registration switch and asks
// Cloudflare, which have no test double here.
vi.mock("../signup_gate", () => ({
  admitSignup: vi.fn(async () => ({ type: "ADMITTED", permit: {} })),
}));
vi.mock("../db/util", () => ({ pool: {}, withPgPoolTransaction: vi.fn() }));
vi.mock("../emailer", () => ({}));
vi.mock("../services/discord", () => ({
  broadcastManualNuke: vi.fn(),
  broadcastManualUnnuke: vi.fn(async () => {}),
  broadcastBioUpdate: vi.fn(),
}));

vi.mock("../avatar", () => ({
  handleAvatarTransformAndUpload: vi.fn(async () => {}),
}));
vi.mock("../storage", () => ({ removeAvatar: vi.fn(async () => {}) }));

vi.mock("../db", () => ({
  findUserByUname: vi.fn(),
  findUserByEmail: vi.fn(),
  createUserWithSession: vi.fn(),
  findUserBySlug: vi.fn(),
  updateUser: vi.fn(),
  updateUserCustomTitle: vi.fn(),
  updateUserActiveTrophyId: vi.fn(),
  deactivateCurrentTrophyForUserId: vi.fn(),
  updateUserRole: vi.fn(),
  unnukeUser: vi.fn(),
  createVm: vi.fn(),
  getVmThreadUserIds: vi.fn(async () => []),
  createReplyVmNotificationsBulk: vi.fn(),
  createTopLevelVmNotificationsBulk: vi.fn(),
  users: { approveUser: vi.fn(async () => {}) },
}));

////////////////////////////////////////////////////////////
// Fixtures

const alice = { id: 1, uname: "Alice", slug: "alice", role: "member" };
const bob = { id: 2, uname: "Bob", slug: "bob", role: "member" };
const smod = { id: 3, uname: "Smod", slug: "smod", role: "smod" };
const otherSmod = { id: 4, uname: "Other", slug: "other", role: "smod" };
const mod = { id: 6, uname: "Mod", slug: "mod", role: "mod" };
const nukedConmod = {
  id: 7,
  uname: "Conmod",
  slug: "conmod",
  role: "conmod",
  is_nuked: true,
};
const spambot = {
  id: 8,
  uname: "Spambot",
  slug: "spambot",
  role: "banned",
  is_nuked: true,
};
const users = [alice, bob, smod, otherSmod, mod, nukedConmod, spambot];
const trophyId = 5;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.findUserBySlug).mockImplementation(async (slug: string) => {
    const user = users.find((u) => u.slug === slug);
    return user ? ({ ...user } as any) : undefined;
  });
  vi.mocked(db.updateUserActiveTrophyId).mockResolvedValue(true);
  vi.mocked(db.deactivateCurrentTrophyForUserId).mockResolvedValue(undefined);
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim and the ValidationError handler mirror the ones in server/index.ts, so
// a denied check is a 404 and a bad field a redirect back with a danger
// flash. The flash setter records what the handler set, since there is no
// flash middleware.

type Req = {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  currUser: object | null;
  // Form fields, as the app-wide body parser would leave them.
  body?: object;
  // A raw multipart body, which only withUpload reads.
  form?: FormData;
};

async function send(req: Req) {
  let flash: unknown;
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = req.currUser;
    (ctx.request as any).body = req.body ?? {};
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    Object.defineProperty(ctx, "flash", {
      get: () => flash,
      set: (value) => {
        flash = value;
      },
    });
    return next();
  });
  app.use(bouncer.middleware());
  app.use(async (ctx: Context, next: Next) => {
    try {
      await next();
    } catch (ex) {
      if (!(ex instanceof bouncer.ValidationError)) throw ex;
      ctx.flash = { message: ["danger", ex.message] };
      ctx.back("/");
    }
  });
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
      method: req.method,
      redirect: "manual",
      body: req.form,
    });
    return { status: res.status, location: res.headers.get("location"), flash };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const avatarBytes = Buffer.from("not really a png");

// The Edit Avatar form in views/edit_user.html: one file input and two
// submit buttons named submit.
function avatarForm(submit: "save" | "delete", file: Blob, filename: string) {
  const form = new FormData();
  form.append("avatar", file, filename);
  form.append("submit", submit);
  return form;
}

////////////////////////////////////////////////////////////

describe("POST /users", () => {
  // Intent: signup answers a taken name with the form and a flash.
  // Why it exists: a name some member changed away from stays reserved in
  // the unames history, which the route's own check does not read. The
  // route caught createUserWithSession's refusal, then read the user it never
  // made, and answered 500 (hunt 261117-0852-044).
  // Scenario: a visitor registers a retired name, which createUserWithSession
  // refuses.
  it("sends a taken name back to the form with a flash", async () => {
    vi.mocked(db.createUserWithSession).mockResolvedValue({
      type: "UNAME_TAKEN",
    });

    const res = await send({
      method: "POST",
      path: "/users",
      currUser: null,
      body: {
        uname: "Retired",
        email: "new@example.com",
        password1: "secret1",
        password2: "secret1",
      },
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/register");
    expect(res.flash).toMatchObject({
      message: ["danger", "Username is taken"],
    });
  });
});

describe("POST /users/:slug/avatar", () => {
  it("hands the uploaded bytes to the avatar transform", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/avatar",
      currUser: alice,
      form: avatarForm(
        "save",
        new Blob([avatarBytes], { type: "image/png" }),
        "me.png",
      ),
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/alice/edit#avatar");
    expect(withUpload).toHaveBeenCalledTimes(1);
    expect(avatar.handleAvatarTransformAndUpload).toHaveBeenCalledWith(
      alice.id,
      avatarBytes,
    );
  });

  // A browser sends an empty part with filename="" for a file input left
  // empty, which is how Delete Avatar is always submitted.
  it("deletes the avatar when the file input is empty", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/avatar",
      currUser: alice,
      form: avatarForm("delete", new Blob([]), ""),
    });

    expect(res.status).toBe(302);
    expect(storage.removeAvatar).toHaveBeenCalledWith(alice.id);
    expect(avatar.handleAvatarTransformAndUpload).not.toHaveBeenCalled();
  });

  it("asks for a file when Save is pressed with the input empty", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/avatar",
      currUser: alice,
      form: avatarForm("save", new Blob([]), ""),
    });

    expect(res.status).toBe(400);
    expect(avatar.handleAvatarTransformAndUpload).not.toHaveBeenCalled();
  });

  // The transcode reads the format from the bytes, so the type the client
  // declares decides nothing, and its refusal comes back as a flash.
  it("shows the transcode's refusal as a flash and saves nothing", async () => {
    const refusal = new UnsupportedImage("Could not use that image.");
    vi.mocked(avatar.handleAvatarTransformAndUpload).mockRejectedValueOnce(
      refusal,
    );

    const res = await send({
      method: "POST",
      path: "/users/alice/avatar",
      currUser: alice,
      form: avatarForm(
        "save",
        new Blob(["hello"], { type: "text/plain" }),
        "notes.txt",
      ),
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/alice/edit#avatar");
    expect(res.flash).toEqual({ message: ["danger", refusal.message] });
    expect(avatar.handleAvatarTransformAndUpload).toHaveBeenCalledWith(
      alice.id,
      Buffer.from("hello"),
    );
  });

  it("refuses a guest before parsing the upload", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/avatar",
      currUser: null,
      form: avatarForm("delete", new Blob([]), ""),
    });

    expect(res.status).toBe(404);
    expect(withUpload).not.toHaveBeenCalled();
    expect(storage.removeAvatar).not.toHaveBeenCalled();
  });

  it("refuses another member before parsing the upload", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/avatar",
      currUser: bob,
      form: avatarForm("delete", new Blob([]), ""),
    });

    expect(res.status).toBe(404);
    expect(withUpload).not.toHaveBeenCalled();
    expect(storage.removeAvatar).not.toHaveBeenCalled();
  });
});

describe("PUT /me/active-trophy", () => {
  it("activates the trophy on the caller, whatever the body names", async () => {
    const res = await send({
      method: "PUT",
      path: "/me/active-trophy",
      currUser: alice,
      body: { trophy_id: String(trophyId), user_id: String(bob.id) },
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/alice");
    expect(res.flash).toEqual({ message: ["success", "Trophy activated"] });
    expect(db.updateUserActiveTrophyId).toHaveBeenCalledWith(
      alice.id,
      trophyId,
    );
  });

  // The write helper matches no row when the caller does not hold the trophy.
  it("404s without a success flash when the write changed no row", async () => {
    vi.mocked(db.updateUserActiveTrophyId).mockResolvedValue(false);

    const res = await send({
      method: "PUT",
      path: "/me/active-trophy",
      currUser: alice,
      body: { trophy_id: String(trophyId) },
    });

    expect(res.status).toBe(404);
    expect(res.flash).toBeUndefined();
  });
});

describe("DELETE /me/active-trophy", () => {
  it("clears the caller's trophy", async () => {
    const res = await send({
      method: "DELETE",
      path: "/me/active-trophy",
      currUser: alice,
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/alice");
    expect(db.deactivateCurrentTrophyForUserId).toHaveBeenCalledWith(alice.id);
  });
});

// Intent: the users router serves no trophy route keyed by a user id.
// Why it exists: PUT /users/:user_id/active-trophy let any member set another
// member's trophy, and its 404-or-redirect answer told them who holds an
// anonymous award. Those routes lived in server/index.ts, which this harness
// cannot load, so this guards only against their return here.
describe("/users/:user_id/active-trophy", () => {
  it("is gone for both methods", async () => {
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await send({
        method,
        path: `/users/${bob.id}/active-trophy`,
        currUser: alice,
        body: { trophy_id: String(trophyId) },
      });
      expect(res.status).toBe(404);
    }

    expect(db.updateUserActiveTrophyId).not.toHaveBeenCalled();
    expect(db.deactivateCurrentTrophyForUserId).not.toHaveBeenCalled();
  });
});

describe("PUT /users/:slug", () => {
  // Intent: the generic profile route never writes users.custom_title.
  // Why it exists: it wrote the title after checking only UPDATE_USER, so a
  // hand-made request got past UPDATE_USER_CUSTOM_TITLE, which only hid the
  // form (hunt 261026-0911-029).
  // Scenario: an smod PUTs another smod's profile with a custom-title field.
  it("refuses a custom-title instead of writing it", async () => {
    const res = await send({
      method: "PUT",
      path: `/users/${otherSmod.slug}`,
      currUser: smod,
      body: { "custom-title": "Retitled" },
    });

    expect(db.updateUser).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});

describe("PUT /users/:slug/custom-title", () => {
  it("lets a member set their own title, trimmed", async () => {
    const res = await send({
      method: "PUT",
      path: `/users/${alice.slug}/custom-title`,
      currUser: alice,
      body: { "custom-title": "  The Bearded  " },
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/alice/edit");
    expect(db.updateUserCustomTitle).toHaveBeenCalledWith(
      alice.id,
      "The Bearded",
    );
  });

  it("does not let an smod retitle another smod", async () => {
    const res = await send({
      method: "PUT",
      path: `/users/${otherSmod.slug}/custom-title`,
      currUser: smod,
      body: { "custom-title": "Retitled" },
    });

    expect(res.status).toBe(404);
    expect(db.updateUserCustomTitle).not.toHaveBeenCalled();
  });

  it("sends a title over 50 chars back without writing it", async () => {
    const res = await send({
      method: "PUT",
      path: `/users/${alice.slug}/custom-title`,
      currUser: alice,
      body: { "custom-title": "x".repeat(51) },
    });

    expect(res.status).toBe(302);
    expect(res.flash).toMatchObject({
      message: ["danger", expect.stringContaining("up to 50 chars")],
    });
    expect(db.updateUserCustomTitle).not.toHaveBeenCalled();
  });
});

describe("PUT /users/:slug/role", () => {
  // Intent: the role route refuses any role the actor may not grant, through
  // UPDATE_USER_ROLE, before it writes.
  // Why it exists: the grant limit was a clamp in the route body that no test
  // covered, so deleting it let a mod make a member an admin (hunt
  // 261117-0852-014).
  // Scenario: a mod or an smod forges the role field of the edit form.
  it.each([
    { actor: mod, role: "admin" },
    { actor: smod, role: "admin" },
    { actor: smod, role: "smod" },
  ])("refuses a $actor.role making a member $role", async ({ actor, role }) => {
    const res = await send({
      method: "PUT",
      path: `/users/${alice.slug}/role`,
      currUser: actor,
      body: { role },
    });

    expect(res.status).toBe(404);
    expect(db.updateUserRole).not.toHaveBeenCalled();
  });

  it("lets a mod make a member a pwmod", async () => {
    const res = await send({
      method: "PUT",
      path: `/users/${alice.slug}/role`,
      currUser: mod,
      body: { role: "pwmod" },
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/alice/edit");
    expect(db.updateUserRole).toHaveBeenCalledWith({
      actorId: mod.id,
      userId: alice.id,
      role: "pwmod",
    });
  });
});

describe("POST /users/:slug/vms", () => {
  beforeEach(() => {
    vi.mocked(withPgPoolTransaction).mockImplementation(async (_pool, fn) =>
      fn({} as any),
    );
  });

  // Intent: the route answers createVm's refusal of a reply's parent with a
  // 404, and notifies nobody.
  // Why it exists: a reply could go under a thread on another wall and notify
  // any member the sender named in the URL (hunt 261117-0852-040). createVm
  // owns the rule; this pins how the route answers it.
  // Scenario: Alice posts to Bob's wall with a thread on Carol's wall as the
  // parent.
  it("404s a reply whose parent createVm refuses", async () => {
    vi.mocked(db.createVm).mockRejectedValue(new VmParentRefused());

    const res = await send({
      method: "POST",
      path: `/users/${bob.slug}/vms`,
      currUser: alice,
      body: { markup: "hi", parent_vm_id: "20" },
    });

    expect(res.status).toBe(404);
    expect(res.flash).toBeUndefined();
    expect(db.createReplyVmNotificationsBulk).not.toHaveBeenCalled();
    expect(db.createTopLevelVmNotificationsBulk).not.toHaveBeenCalled();
  });

  it("posts a reply under the named thread", async () => {
    vi.mocked(db.createVm).mockResolvedValue({
      id: 11,
      from_user_id: alice.id,
      to_user_id: bob.id,
      parent_vm_id: 10,
    } as any);

    const res = await send({
      method: "POST",
      path: `/users/${bob.slug}/vms`,
      currUser: alice,
      body: { markup: "hi", parent_vm_id: "10" },
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/bob/vms#vm-11");
    expect(db.createVm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to_user_id: bob.id, parent_vm_id: 10 }),
    );
    expect(db.createReplyVmNotificationsBulk).toHaveBeenCalled();
  });

  // The wall's new-thread form sends markup alone, with no parent_vm_id.
  // createVm takes a null parent for a new thread, never an absent one.
  it("posts a new thread with a null parent", async () => {
    vi.mocked(db.createVm).mockResolvedValue({
      id: 12,
      from_user_id: alice.id,
      to_user_id: bob.id,
      parent_vm_id: null,
    } as any);

    const res = await send({
      method: "POST",
      path: `/users/${bob.slug}/vms`,
      currUser: alice,
      body: { markup: "hi" },
    });

    expect(res.status).toBe(302);
    expect(res.location).toBe("/users/bob/vms#vm-12");
    expect(db.createVm).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to_user_id: bob.id, parent_vm_id: null }),
    );
    expect(db.createTopLevelVmNotificationsBulk).toHaveBeenCalled();
  });
});

describe("POST /users/:slug/unnuke", () => {
  // Intent: unnuke asks the role rule, since it makes the account a member.
  // Why it exists: it asked NUKE_USER, which let a mod demote a conmod or
  // arenamod and unhide every post staff had hidden (hunt 261117-0852-014).
  // Scenario: a mod unnukes a contest mod.
  it("refuses a mod unnuking a conmod", async () => {
    const res = await send({
      method: "POST",
      path: `/users/${nukedConmod.slug}/unnuke`,
      currUser: mod,
    });

    expect(res.status).toBe(404);
    expect(db.unnukeUser).not.toHaveBeenCalled();
  });

  it("lets a mod unnuke a spambot", async () => {
    const res = await send({
      method: "POST",
      path: `/users/${spambot.slug}/unnuke`,
      currUser: mod,
    });

    expect(res.status).toBe(302);
    expect(db.unnukeUser).toHaveBeenCalledWith({
      actorId: mod.id,
      userId: spambot.id,
    });
  });
});
