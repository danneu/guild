import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as avatar from "../avatar";
import * as cancan from "../cancan";
import * as db from "../db";
import { withUpload } from "../upload";
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
}));

////////////////////////////////////////////////////////////
// Fixtures

const alice = { id: 1, uname: "Alice", slug: "alice", role: "member" };
const bob = { id: 2, uname: "Bob", slug: "bob", role: "member" };
const users = [alice, bob];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.findUserBySlug).mockImplementation(async (slug: string) => {
    const user = users.find((u) => u.slug === slug);
    return user ? ({ ...user } as any) : undefined;
  });
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what the avatar route reads from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts, so a denied check is a 404 too.

async function send(req: {
  path: string;
  currUser: object | null;
  form: FormData;
}) {
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = req.currUser;
    (ctx.request as any).body = {};
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    return next();
  });
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${req.path}`, {
      method: "POST",
      redirect: "manual",
      body: req.form,
    });
    return { status: res.status, location: res.headers.get("location") };
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
      path: "/users/alice/avatar",
      currUser: alice,
      form: avatarForm("save", new Blob([]), ""),
    });

    expect(res.status).toBe(400);
    expect(avatar.handleAvatarTransformAndUpload).not.toHaveBeenCalled();
  });

  it("refuses a file that is not an image", async () => {
    const res = await send({
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
      path: "/users/alice/avatar",
      currUser: bob,
      form: avatarForm("delete", new Blob([]), ""),
    });

    expect(res.status).toBe(404);
    expect(withUpload).not.toHaveBeenCalled();
    expect(db.deleteAvatar).not.toHaveBeenCalled();
  });
});
