import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cancan from "../cancan";
import * as db from "../db";
import { uploadToS3 } from "../s3";
import "../validation";
import router from "./images";

// The upload route answers "offline" before any check when the bucket is
// unset, which would hide the album check this file tests.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  S3_IMAGE_BUCKET: "test-bucket",
}));

vi.mock("../s3", () => ({
  uploadToS3: vi.fn(async () => ({
    publicUrl: "https://img.roleplayerguild.com/test/new.avif",
  })),
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    avif: () => ({ toBuffer: async () => Buffer.from("avif") }),
  })),
}));

vi.mock("../db", () => ({
  getUserBySlug: vi.fn(),
  images: {
    getImage: vi.fn(),
    getUserImage: vi.fn(),
    getAlbum: vi.fn(),
    getUserAlbum: vi.fn(),
    insertImage: vi.fn(),
    deleteImage: vi.fn(),
    updateAlbum: vi.fn(),
  },
}));

////////////////////////////////////////////////////////////
// Fixtures

const alice = { id: 1, uname: "Alice", slug: "alice", role: "member" };
const bob = { id: 2, uname: "Bob", slug: "bob", role: "member" };
const mod = { id: 3, uname: "Mod", slug: "mod", role: "mod" };
const users = [alice, bob, mod];

const aliceAlbum = { id: 10, user_id: alice.id, title: "Alice's album" };
const bobAlbum = { id: 20, user_id: bob.id, title: "Bob's album" };
const albums = [aliceAlbum, bobAlbum];

const aliceImage = {
  id: "0190d5a0-0000-7000-8000-000000000001",
  user_id: alice.id,
  album_id: aliceAlbum.id,
  src: "https://img.roleplayerguild.com/prod/users/alice.avif",
  mime: "image/avif",
  description: null,
};
const bobImage = {
  id: "0190d5a0-0000-7000-8000-000000000002",
  user_id: bob.id,
  album_id: bobAlbum.id,
  src: "https://img.roleplayerguild.com/prod/users/bob.avif",
  mime: "image/avif",
  description: null,
};
const images = [aliceImage, bobImage];

function userById(id: number) {
  return users.find((u) => u.id === id)!;
}

// Fresh copies, because the presenters mutate what the loaders return.
function imageRow(image: (typeof images)[number]) {
  const { uname, slug } = userById(image.user_id);
  return { ...image, user: { uname, slug } };
}

function albumRow(album: (typeof albums)[number]) {
  return { ...album, user: { ...userById(album.user_id) } };
}

// These stubs answer like the real queries in server/db/images.ts: the bare
// getters find any row by id, and the getUser* twins only the owner's rows.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getUserBySlug).mockImplementation(async (slug: string) => {
    const user = users.find((u) => u.slug === slug);
    return user ? ({ ...user } as any) : undefined;
  });
  const m = vi.mocked(db.images) as any;
  m.getImage.mockImplementation(async (id: string) => {
    const image = images.find((i) => i.id === id);
    return image ? imageRow(image) : undefined;
  });
  m.getUserImage.mockImplementation(async (ownerId: number, id: string) => {
    const image = images.find((i) => i.id === id && i.user_id === ownerId);
    return image ? imageRow(image) : undefined;
  });
  m.getAlbum.mockImplementation(async (id: number | string) => {
    const album = albums.find((a) => a.id === Number(id));
    return album ? albumRow(album) : undefined;
  });
  m.getUserAlbum.mockImplementation(async (ownerId: number, id: number) => {
    const album = albums.find((a) => a.id === id && a.user_id === ownerId);
    return album ? albumRow(album) : undefined;
  });
  m.insertImage.mockResolvedValue(true);
  m.deleteImage.mockResolvedValue(true);
  m.updateAlbum.mockResolvedValue(true);
});

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts, so a denied check is a 404 too.

type Req = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  currUser: object | null;
  body?: object;
  files?: object;
};

async function send(req: Req) {
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    ctx.currUser = req.currUser;
    (ctx.request as any).body = req.body ?? {};
    (ctx.request as any).files = req.files;
    ctx.assertAuthorized = (user: any, action: any, target: any) => {
      ctx.assert(cancan.can(user, action, target), 404);
    };
    ctx.render = async (template: string) => {
      ctx.body = template;
    };
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
    });
    return { status: res.status, location: res.headers.get("location") };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const upload = { image: { size: 1000, filepath: "/nonexistent/upload.png" } };

////////////////////////////////////////////////////////////

describe("GET /users/:user_slug/images/:image_id", () => {
  it("shows an image under its owner's slug", async () => {
    const res = await send({
      method: "GET",
      path: `/users/bob/images/${bobImage.id}`,
      currUser: alice,
    });

    expect(res.status).toBe(200);
  });

  // The page would call Bob's image Alice's and show Alice its Delete button.
  it("404s on a slug that does not own the image", async () => {
    const res = await send({
      method: "GET",
      path: `/users/alice/images/${bobImage.id}`,
      currUser: alice,
    });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /users/:user_slug/images/:image_id", () => {
  it("lets a member delete their own image", async () => {
    const res = await send({
      method: "DELETE",
      path: `/users/alice/images/${aliceImage.id}`,
      currUser: alice,
    });

    expect(res.status).toBe(302);
    expect(db.images.deleteImage).toHaveBeenCalledWith(alice.id, aliceImage.id);
  });

  it("lets staff delete a member's image under that member's slug", async () => {
    const res = await send({
      method: "DELETE",
      path: `/users/bob/images/${bobImage.id}`,
      currUser: mod,
    });

    expect(res.status).toBe(302);
    expect(db.images.deleteImage).toHaveBeenCalledWith(bob.id, bobImage.id);
  });

  it("does not delete another user's image under the caller's own slug", async () => {
    const res = await send({
      method: "DELETE",
      path: `/users/alice/images/${bobImage.id}`,
      currUser: alice,
    });

    expect(res.status).toBe(404);
    expect(db.images.deleteImage).not.toHaveBeenCalled();
  });

  it("404s instead of claiming success when the delete matched no row", async () => {
    vi.mocked(db.images.deleteImage).mockResolvedValue(false);

    const res = await send({
      method: "DELETE",
      path: `/users/alice/images/${aliceImage.id}`,
      currUser: alice,
    });

    expect(res.status).toBe(404);
  });
});

describe("PUT /users/:user_slug/albums/:album_id", () => {
  const body = { title: "New title", markup: "" };

  it("lets a member edit their own album", async () => {
    const res = await send({
      method: "PUT",
      path: `/users/alice/albums/${aliceAlbum.id}`,
      currUser: alice,
      body,
    });

    expect(res.status).toBe(302);
    expect(db.images.updateAlbum).toHaveBeenCalledWith(
      alice.id,
      aliceAlbum.id,
      body,
    );
  });

  it("does not edit another user's album under the caller's own slug", async () => {
    const res = await send({
      method: "PUT",
      path: `/users/alice/albums/${bobAlbum.id}`,
      currUser: alice,
      body: { title: "pwned", markup: "" },
    });

    expect(res.status).toBe(404);
    expect(db.images.updateAlbum).not.toHaveBeenCalled();
  });

  it("404s instead of claiming success when the update matched no row", async () => {
    vi.mocked(db.images.updateAlbum).mockResolvedValue(false);

    const res = await send({
      method: "PUT",
      path: `/users/alice/albums/${aliceAlbum.id}`,
      currUser: alice,
      body,
    });

    expect(res.status).toBe(404);
  });
});

describe("POST /users/:user_slug/images", () => {
  it("uploads into the uploader's own album", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      body: { description: "", album_id: String(aliceAlbum.id) },
      files: upload,
    });

    expect(res.status).toBe(302);
    expect(db.images.insertImage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: alice.id, albumId: aliceAlbum.id }),
    );
  });

  // Bob's album page would list Alice's image.
  it("refuses another user's album before encoding or writing to S3", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      body: { description: "", album_id: String(bobAlbum.id) },
      files: upload,
    });

    expect(res.status).toBe(404);
    expect(sharp).not.toHaveBeenCalled();
    expect(uploadToS3).not.toHaveBeenCalled();
    expect(db.images.insertImage).not.toHaveBeenCalled();
  });

  // The album changed owner between the check and the insert.
  it("404s when the scoped insert finds no album the uploader owns", async () => {
    vi.mocked(db.images.insertImage).mockResolvedValue(false);

    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      body: { description: "", album_id: String(aliceAlbum.id) },
      files: upload,
    });

    expect(res.status).toBe(404);
  });
});
