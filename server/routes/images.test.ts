import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as cancan from "../cancan";
import * as config from "../config";
import * as db from "../db";
import { UnsupportedImage, transcodeAlbumImage } from "../imaging";
import {
  addImage,
  addUser,
  fake,
  hasObject,
  resetFakes,
} from "../storage.fixtures";
import { withUpload } from "../upload";
import "../validation";
import router from "./images";

// Spied, so a test can tell whether a request reached the upload parser.
vi.mock("../upload", { spy: true });

// The upload route answers "offline" before any check when the bucket is
// unset, which would hide the album check this file tests. The caps are
// small, so a test reaches them with a few rows.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  S3_IMAGE_BUCKET: "test-bucket",
  S3_IMAGE_PREFIX: "test",
  S3_AVATAR_BUCKET: "test-avatars",
  S3_AVATAR_PREFIX: "test",
  IMAGE_QUOTA: {
    untrusted: { images: 3, bytes: 1_000_000, perHour: 5 },
    trusted: { images: 6, bytes: 2_000_000, perHour: 10 },
  },
}));

// S3 and Postgres are the in-memory stand-ins in server/storage.fixtures.ts,
// so the route runs the real storage code.
vi.mock("../s3", async () => (await import("../storage.fixtures")).fakeS3);
vi.mock(
  "../db/util",
  async () => (await import("../storage.fixtures")).fakeDbUtil,
);

// The real refusal classes, so the route's instanceof check is the real one.
// server/imaging.test.ts runs the real transcode.
vi.mock("../imaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../imaging")>()),
  transcodeAlbumImage: vi.fn(async () => ({
    buffer: Buffer.from("avif"),
    contentType: "image/avif",
  })),
}));

vi.mock("../db", () => ({
  getUserBySlug: vi.fn(),
  images: {
    getImage: vi.fn(),
    getUserImage: vi.fn(),
    getAlbum: vi.fn(),
    getUserAlbum: vi.fn(),
    getUserImages: vi.fn(),
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

// Each image's object, as storage.ts keys it
function objectKey(image: { id: string }) {
  return `test/users/${image.id}.avif`;
}

// These stubs answer like the real queries in server/db/images.ts: the bare
// getters find any row by id, and the getUser* twins only the owner's rows.
// The storage stand-ins hold the same users, albums and images, with each
// image's object in the bucket.
beforeEach(() => {
  vi.clearAllMocks();
  resetFakes();
  for (const user of users) addUser({ id: user.id, uname: user.uname });
  fake.albums = albums.map(({ id, user_id }) => ({ id, user_id }));
  for (const image of images) {
    addImage({ ...image, bytes: 100 });
    fake.objects.add(`test-bucket/${objectKey(image)}`);
  }
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
  m.getUserImages.mockImplementation(async (ownerId: number) =>
    images.filter((i) => i.user_id === ownerId).map(imageRow),
  );
  m.updateAlbum.mockResolvedValue(true);
});

function fakeRow(id: string) {
  return fake.images.find((image) => image.id === id)!;
}

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with only what these routes read from ctx. server/index.ts
// cannot be imported here: loading it starts cache3 and app.listen. The authz
// shim mirrors the one in server/index.ts, so a denied check is a 404 too.
// The flash setter records what the handler set, since there is no flash
// middleware.

type Req = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  currUser: object | null;
  // Stands in for a parsed urlencoded body.
  body?: object;
  // Sent as a real multipart body, which the upload route parses itself.
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
    ctx.render = async (template: string) => {
      ctx.body = template;
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
      ...(req.form ? { body: req.form } : {}),
    });
    return { status: res.status, location: res.headers.get("location"), flash };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const imageBytes = Buffer.from("not really a png");

function uploadForm(albumId: number) {
  const form = new FormData();
  form.append("album_id", String(albumId));
  form.append(
    "image",
    new Blob([imageBytes], { type: "image/png" }),
    "upload.png",
  );
  form.append("description", "");
  return form;
}

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
  // A delete used to hide the row and leave the object public.
  it("lets a member delete their own image, object and all", async () => {
    const res = await send({
      method: "DELETE",
      path: `/users/alice/images/${aliceImage.id}`,
      currUser: alice,
    });

    expect(res.status).toBe(302);
    expect(hasObject("test-bucket", objectKey(aliceImage))).toBe(false);
    expect(fakeRow(aliceImage.id).deleted_at).not.toBeNull();
  });

  it("lets staff delete a member's image under that member's slug", async () => {
    const res = await send({
      method: "DELETE",
      path: `/users/bob/images/${bobImage.id}`,
      currUser: mod,
    });

    expect(res.status).toBe(302);
    expect(hasObject("test-bucket", objectKey(bobImage))).toBe(false);
    expect(fakeRow(bobImage.id).deleted_at).not.toBeNull();
  });

  it("does not delete another user's image under the caller's own slug", async () => {
    const res = await send({
      method: "DELETE",
      path: `/users/alice/images/${bobImage.id}`,
      currUser: alice,
    });

    expect(res.status).toBe(404);
    expect(fake.events).toEqual([]);
    expect(hasObject("test-bucket", objectKey(bobImage))).toBe(true);
  });

  // Another delete hid the row after the page loaded it.
  it("404s instead of claiming success when the delete matched no row", async () => {
    fakeRow(aliceImage.id).deleted_at = new Date();

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
      form: uploadForm(aliceAlbum.id),
    });

    expect(res.status).toBe(302);
    expect(withUpload).toHaveBeenCalledTimes(1);
    expect(transcodeAlbumImage).toHaveBeenCalledWith(imageBytes);
    const row = fake.images.at(-1)!;
    expect(row).toMatchObject({
      user_id: alice.id,
      album_id: aliceAlbum.id,
      mime: "image/avif",
      bytes: Buffer.from("avif").length,
      src: `https://img.roleplayerguild.com/${objectKey(row)}`,
    });
    // The row is in before its object
    expect(fake.events).toEqual([
      { op: "insert", id: row.id },
      { op: "put", bucket: "test-bucket", key: objectKey(row) },
    ]);
  });

  it("shows the transcode's refusal as a flash and stores nothing", async () => {
    vi.mocked(transcodeAlbumImage).mockRejectedValueOnce(
      new UnsupportedImage("Could not use that image."),
    );

    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      form: uploadForm(aliceAlbum.id),
    });

    expect(res.status).toBe(302);
    expect(res.flash).toEqual({
      message: ["danger", "Could not use that image."],
    });
    expect(fake.events).toEqual([]);
  });

  it("refuses a guest before parsing the upload", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: null,
      form: uploadForm(aliceAlbum.id),
    });

    expect(res.status).toBe(404);
    expect(withUpload).not.toHaveBeenCalled();
  });

  it("refuses another member before parsing the upload", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: bob,
      form: uploadForm(bobAlbum.id),
    });

    expect(res.status).toBe(404);
    expect(withUpload).not.toHaveBeenCalled();
  });

  // Bob's album page would list Alice's image.
  it("refuses another user's album before encoding or writing to S3", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      form: uploadForm(bobAlbum.id),
    });

    expect(res.status).toBe(404);
    expect(transcodeAlbumImage).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
  });

  // Intent: an account at its image cap is refused before its upload
  // reaches S3.
  // Why it exists: the route stored every upload with no per-account count,
  // byte or hourly cap, so one account could keep any number of public
  // images at the forum's URLs (hunt 261117-0852-013).
  // Scenario: Alice, a new member, already keeps as many images as her cap
  // allows and uploads one more.
  it("refuses an upload past the account's image cap before writing to S3", async () => {
    const cap = config.IMAGE_QUOTA.untrusted.images;
    for (let i = 0; i < cap; i++) {
      addImage({ user_id: alice.id, album_id: aliceAlbum.id });
    }

    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      form: uploadForm(aliceAlbum.id),
    });

    expect(fake.events.filter((event) => event.op === "put")).toEqual([]);
    expect(transcodeAlbumImage).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.flash).toEqual({
      message: [
        "danger",
        `You can keep at most ${cap} images. Delete some to upload more.`,
      ],
    });
  });

  // The early read lets Alice through with room for one byte, and the
  // locked check in storeImage, which sees the transcoded size, refuses.
  it("refuses at the locked check when the image passes the byte cap", async () => {
    const cap = config.IMAGE_QUOTA.untrusted.bytes;
    fakeRow(aliceImage.id).bytes = cap - 1;

    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      form: uploadForm(aliceAlbum.id),
    });

    expect(transcodeAlbumImage).toHaveBeenCalled();
    expect(fake.events).toEqual([]);
    expect(res.status).toBe(302);
    expect(res.flash).toEqual({
      message: [
        "danger",
        "Your images can take up at most 1 MB. Delete some to upload more.",
      ],
    });
  });

  // The album changed owner between the check and the insert.
  it("404s when the scoped insert finds no album the uploader owns", async () => {
    fake.albums = [{ id: aliceAlbum.id, user_id: bob.id }];

    const res = await send({
      method: "POST",
      path: "/users/alice/images",
      currUser: alice,
      form: uploadForm(aliceAlbum.id),
    });

    expect(res.status).toBe(404);
    expect(fake.events).toEqual([]);
  });
});

describe("/users/:user_slug/remove-uploads", () => {
  it("shows staff the confirm page", async () => {
    const res = await send({
      method: "GET",
      path: "/users/alice/remove-uploads",
      currUser: mod,
    });

    expect(res.status).toBe(200);
    expect(fake.events).toEqual([]);
  });

  it("takes down the member's images and avatar once confirmed", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/remove-uploads",
      currUser: mod,
      body: { confirm: "remove-uploads" },
    });

    expect(res.status).toBe(302);
    expect(res.flash).toEqual({
      message: ["success", "Removed 1 images and the avatar"],
    });
    expect(hasObject("test-bucket", objectKey(aliceImage))).toBe(false);
    expect(fakeRow(aliceImage.id).deleted_at).not.toBeNull();
    expect(fake.events).toContainEqual({
      op: "delete",
      bucket: "test-avatars",
      keys: [`test/${alice.id}.webp`, `test/32/${alice.id}.webp`],
    });
    // Bob's image stays
    expect(hasObject("test-bucket", objectKey(bobImage))).toBe(true);
    expect(fakeRow(bobImage.id).deleted_at).toBeNull();
  });

  it("refuses a post that did not come from the confirm page", async () => {
    const res = await send({
      method: "POST",
      path: "/users/alice/remove-uploads",
      currUser: mod,
    });

    expect(res.status).toBe(400);
    expect(fake.events).toEqual([]);
  });

  it.each([
    ["the member themselves", alice],
    ["another member", bob],
  ])("refuses %s", async (_who, currUser) => {
    for (const method of ["GET", "POST"] as const) {
      const res = await send({
        method,
        path: "/users/alice/remove-uploads",
        currUser,
        body: { confirm: "remove-uploads" },
      });

      expect(res.status).toBe(404);
    }
    expect(fake.events).toEqual([]);
  });
});
