import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as avatar from "../avatar";
import * as cancan from "../cancan";
import * as db from "../db";
import { withUpload } from "../upload";
import "../validation";
import router from "./users";

// Spied, so a test can tell whether a request reached the upload parser.
vi.mock("../upload", { spy: true });

// Importing server/cache3.ts starts its interval cache. server/bbcode.js
// requires it outside vitest's module graph, so bbcode is stubbed too.
vi.mock("../cache3", () => ({ default: {} }));
vi.mock("../bbcode", () => ({ default: vi.fn() }));
vi.mock("../db/util", () => ({ pool: {}, withPgPoolTransaction: vi.fn() }));
vi.mock("../emailer", () => ({}));
vi.mock("../services/discord", () => ({
  broadcastManualNuke: vi.fn(),
  broadcastManualUnnuke: vi.fn(),
  broadcastBioUpdate: vi.fn(),
}));

vi.mock("../avatar", () => ({
  handleAvatarTransformAndUpload: vi.fn(
    async () => "https://avatars.roleplayerguild.com/new.webp",
  ),
}));

vi.mock("../db", () => ({
  findUserBySlug: vi.fn(),
  deleteAvatar: vi.fn(),
  updateUser: vi.fn(),
  deleteLegacyAvatar: vi.fn(),
  updateUserActiveTrophyId: vi.fn(),
  deactivateCurrentTrophyForUserId: vi.fn(),
}));

////////////////////////////////////////////////////////////
// Fixtures

const alice = { id: 1, uname: "Alice", slug: "alice", role: "member" };
const bob = { id: 2, uname: "Bob", slug: "bob", role: "member" };
const users = [alice, bob];
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
// shim mirrors the one in server/index.ts, so a denied check is a 404 too.
// The flash setter records what the handler set, since there is no flash
// middleware.

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
      avatarBytes,
    );
    expect(db.updateUser).toHaveBeenCalledWith(alice.id, {
      avatar_url: "https://avatars.roleplayerguild.com/new.webp",
    });
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
    expect(db.deleteAvatar).toHaveBeenCalledWith(alice.id);
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

  it("refuses a file that is not an image", async () => {
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

    expect(res.status).toBe(400);
    expect(avatar.handleAvatarTransformAndUpload).not.toHaveBeenCalled();
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
    expect(db.deleteAvatar).not.toHaveBeenCalled();
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
    expect(db.deleteAvatar).not.toHaveBeenCalled();
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
