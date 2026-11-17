import { beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "./config";
import { mergeUsers } from "./db/admin";
import { presentUser } from "./presenters";
import {
  checkImageQuota,
  removeAvatar,
  removeImage,
  removeUploads,
  StorageQuotaExceeded,
  storeAvatar,
  storeImage,
} from "./storage";
import {
  addImage,
  addUser,
  fake,
  hasObject,
  resetFakes,
  type FakeImage,
} from "./storage.fixtures";

// This deployment's folders differ from production's and development's, so a
// key built from anything but config shows up.
vi.mock("./config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config")>()),
  S3_IMAGE_BUCKET: "images",
  S3_AVATAR_BUCKET: "avatars",
  S3_IMAGE_PREFIX: "here",
  S3_AVATAR_PREFIX: "here-avatars",
  IMAGE_QUOTA: {
    untrusted: { images: 3, bytes: 2_000_000, perHour: 4 },
    trusted: { images: 6, bytes: 4_000_000, perHour: 8 },
  },
}));
vi.mock("./s3", async () => (await import("./storage.fixtures")).fakeS3);
vi.mock(
  "./db/util",
  async () => (await import("./storage.fixtures")).fakeDbUtil,
);

const QUOTA = config.IMAGE_QUOTA.untrusted;
const EXTENSIONS = ["avif", "webp", "png", "jpg", "gif"];

const owner = 1;
const other = 2;
const album = 10;

function avif(bytes = 100) {
  return { buffer: Buffer.alloc(bytes), contentType: "image/avif" as const };
}

function store(bytes = 100) {
  return storeImage({
    ownerId: owner,
    albumId: album,
    description: null,
    image: avif(bytes),
  });
}

// Every key an image's object may sit under, as removals delete them
function keysOf(image: { id: string }) {
  return EXTENSIONS.map((ext) => `here/users/${image.id}.${ext}`);
}

function keyOf(image: { id: string }) {
  return `here/users/${image.id}.avif`;
}

function newest(): FakeImage {
  return fake.images.at(-1)!;
}

function inTheHour(): Date {
  return new Date(Date.now() - 10 * 60 * 1000);
}

// Holds a fake call open. `reached` resolves once the call arrives, and the
// call waits until `release` runs.
function hold() {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    async hook() {
      arrive();
      await released;
    },
  };
}

beforeEach(() => {
  resetFakes();
  addUser({ id: owner });
  addUser({ id: other });
  fake.albums = [
    { id: album, user_id: owner },
    { id: 20, user_id: other },
  ];
});

////////////////////////////////////////////////////////////

describe("storeImage", () => {
  it("inserts the row, then puts the object under the row's own key", async () => {
    await expect(store(123)).resolves.toBe(true);

    const row = newest();
    expect(row).toMatchObject({
      user_id: owner,
      album_id: album,
      bytes: 123,
      mime: "image/avif",
      src: `https://img.roleplayerguild.com/${keyOf(row)}`,
    });
    expect(fake.events).toEqual([
      { op: "insert", id: row.id },
      { op: "put", bucket: "images", key: keyOf(row) },
    ]);
  });

  // The row takes its user_id from the album, so it exists only when the
  // named owner holds the album.
  it("writes nothing into an album the owner does not hold", async () => {
    await expect(
      storeImage({
        ownerId: owner,
        albumId: 20,
        description: null,
        image: avif(),
      }),
    ).resolves.toBe(false);

    expect(fake.events).toEqual([]);
    const insert = fake.statements.find((s) =>
      /INSERT INTO images/.test(s.sql),
    )!;
    expect(insert.sql).toMatch(
      /SELECT \$1::uuid, albums\.id, albums\.user_id,/,
    );
    expect(insert.sql).toMatch(
      /WHERE albums\.id = \$2\s+AND albums\.user_id = \$3/,
    );
  });

  // Intent: each cap refuses before anything is written.
  // Why it exists: uploads had no per-account bound (hunt 261117-0852-013).
  // Scenario: an untrusted member is at one cap and uploads once more.
  it.each<[string, () => void, RegExp]>([
    [
      "the image count",
      () => {
        for (let i = 0; i < QUOTA.images; i++) addImage({ user_id: owner });
      },
      /at most 3 images/,
    ],
    [
      "the bytes",
      () => addImage({ user_id: owner, bytes: QUOTA.bytes - 50 }),
      /at most 2 MB/,
    ],
    [
      "the hourly uploads, deleted ones included",
      () => {
        for (let i = 0; i < QUOTA.perHour; i++) {
          addImage({
            user_id: owner,
            created_at: inTheHour(),
            deleted_at: new Date(),
          });
        }
      },
      /4 images per hour\. Try again in \d+ minutes/,
    ],
  ])("refuses past %s before any write", async (_cap, seed, message) => {
    seed();
    const before = fake.images.length;

    await expect(store(100)).rejects.toThrow(StorageQuotaExceeded);
    await expect(store(100)).rejects.toThrow(message);

    expect(fake.images.length).toBe(before);
    expect(fake.events).toEqual([]);
  });

  it("does not count deleted images toward the live caps", async () => {
    for (let i = 0; i < QUOTA.images; i++) {
      addImage({ user_id: owner, bytes: QUOTA.bytes, deleted_at: new Date() });
    }

    await expect(store()).resolves.toBe(true);
  });

  it("gives a trusted member the trusted caps", async () => {
    fake.users.find((u) => u.id === owner)!.approved_at = new Date();
    for (let i = 0; i < QUOTA.images; i++) addImage({ user_id: owner });

    await expect(store()).resolves.toBe(true);
  });

  it("checks the caps in the early read too", async () => {
    for (let i = 0; i < QUOTA.images; i++) addImage({ user_id: owner });

    await expect(checkImageQuota(owner)).rejects.toThrow(StorageQuotaExceeded);
    await expect(checkImageQuota(other)).resolves.toBeUndefined();
  });

  it("deletes and then hides after a failed put, and rethrows", async () => {
    const failure = new Error("S3 timed out");
    fake.beforePut = async () => {
      throw failure;
    };

    await expect(store()).rejects.toBe(failure);

    const row = newest();
    expect(row.deleted_at).not.toBeNull();
    expect(fake.events).toEqual([
      { op: "insert", id: row.id },
      { op: "delete", bucket: "images", keys: keysOf(row) },
      { op: "hide", ids: [row.id] },
      { op: "delete", bucket: "images", keys: keysOf(row) },
    ]);
  });

  // The object may exist, so the row stays for its owner to delete later.
  it("keeps the row live when S3 refuses the cleanup too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.beforePut = async () => {
      throw new Error("S3 is down");
    };
    fake.beforeDelete = async () => {
      throw new Error("S3 is down");
    };

    await expect(store()).rejects.toThrow("S3 is down");

    expect(newest().deleted_at).toBeNull();
    expect(fake.events).toEqual([{ op: "insert", id: newest().id }]);
  });
});

describe("removeImage", () => {
  it("deletes the object before it hides the row, then deletes again", async () => {
    const image = addImage({ user_id: owner });
    fake.objects.add(`images/${keyOf(image)}`);

    await expect(removeImage(owner, image.id)).resolves.toBe(true);

    expect(hasObject("images", keyOf(image))).toBe(false);
    expect(image.deleted_at).not.toBeNull();
    expect(fake.events).toEqual([
      { op: "delete", bucket: "images", keys: keysOf(image) },
      { op: "hide", ids: [image.id] },
      { op: "delete", bucket: "images", keys: keysOf(image) },
    ]);
    const hide = fake.statements.find((s) =>
      /SET deleted_at = NOW/.test(s.sql),
    )!;
    expect(hide.sql).toMatch(
      /WHERE user_id = \$1\s+AND id = ANY\(\$2::uuid\[\]\)\s+AND deleted_at IS NULL/,
    );
  });

  it("leaves another owner's image alone", async () => {
    const image = addImage({ user_id: other });

    await expect(removeImage(owner, image.id)).resolves.toBe(false);

    expect(image.deleted_at).toBeNull();
    expect(fake.events).toEqual([]);
  });

  it("keeps the row live when S3 refuses the delete", async () => {
    const image = addImage({ user_id: owner });
    fake.beforeDelete = async () => {
      throw new Error("AccessDenied");
    };

    await expect(removeImage(owner, image.id)).rejects.toThrow("AccessDenied");

    expect(image.deleted_at).toBeNull();
  });

  it("brings the row back when S3 refuses the second delete", async () => {
    const image = addImage({ user_id: owner });
    let deletes = 0;
    fake.beforeDelete = async () => {
      deletes += 1;
      if (deletes === 2) throw new Error("AccessDenied");
    };

    await expect(removeImage(owner, image.id)).rejects.toThrow("AccessDenied");

    expect(image.deleted_at).toBeNull();
  });

  // Intent: a row from before this owner existed is removed by keys built
  // from its own id, never from its src.
  // Why it exists: old objects sit under other extensions, and src is not a
  // key to trust: another deployment's copy of a row names its keys.
  // Scenario: a 2016 PNG whose src is the legacy S3 URL, and a row whose src
  // names someone else's object.
  it("deletes a legacy row's object by its id under every old extension", async () => {
    const legacy = addImage({
      user_id: owner,
      mime: "image/png",
      src: "https://s3.amazonaws.com/img.roleplayerguild.com/prod/users/x.png",
    });
    fake.objects.add(`images/here/users/${legacy.id}.png`);
    const decoy = addImage({ user_id: other });
    fake.objects.add(`images/${keyOf(decoy)}`);
    legacy.src = `https://img.roleplayerguild.com/${keyOf(decoy)}`;

    await expect(removeImage(owner, legacy.id)).resolves.toBe(true);

    expect(hasObject("images", `here/users/${legacy.id}.png`)).toBe(false);
    expect(hasObject("images", keyOf(decoy))).toBe(true);
    for (const event of fake.events) {
      if (event.op === "delete") expect(event.keys).toEqual(keysOf(legacy));
    }
  });
});

// Intent: an object whose PUT lands after its row was removed still comes
// down.
// Why it exists: the row is live while its PUT runs, so its owner or staff
// can remove it then, and their delete can reach S3 before the PUT does.
// Scenario: the owner deletes a fresh upload while S3 is still storing it.
describe("a PUT that lands after a removal began", () => {
  it("comes down when the removal finished before it landed", async () => {
    const put = hold();
    fake.beforePut = put.hook;
    const storing = store();
    await Promise.race([put.reached, storing]);
    const row = newest();

    await expect(removeImage(owner, row.id)).resolves.toBe(true);
    put.release();
    await storing;

    expect(row.deleted_at).not.toBeNull();
    expect(hasObject("images", keyOf(row))).toBe(false);
  });

  it("comes down when it landed between the removal's delete and its hide", async () => {
    const put = hold();
    fake.beforePut = put.hook;
    const storing = store();
    await Promise.race([put.reached, storing]);
    const row = newest();

    const hide = hold();
    fake.beforeHide = hide.hook;
    const removing = removeImage(owner, row.id);
    await Promise.race([hide.reached, removing]);
    // The PUT lands, and the upload reads its row before the hide
    put.release();
    await storing;
    expect(hasObject("images", keyOf(row))).toBe(true);
    hide.release();
    await removing;

    expect(row.deleted_at).not.toBeNull();
    expect(hasObject("images", keyOf(row))).toBe(false);
  });
});

describe("avatar slot", () => {
  it("puts both sizes under keys named by the user and versions the URL", async () => {
    const webp = (n: number) => ({
      buffer: Buffer.alloc(n),
      contentType: "image/webp" as const,
    });

    await storeAvatar(owner, { normal: webp(10), small: webp(5) });
    const first = fake.users.find((u) => u.id === owner)!.avatar_url;
    await storeAvatar(owner, { normal: webp(10), small: webp(5) });
    const second = fake.users.find((u) => u.id === owner)!.avatar_url;

    const keys = [
      `here-avatars/${owner}.webp`,
      `here-avatars/32/${owner}.webp`,
    ];
    expect(
      fake.events
        .filter((event) => event.op === "put")
        .map((event) => event.op === "put" && event.key)
        .sort(),
    ).toEqual([...keys, ...keys].sort());
    for (const url of [first, second]) {
      expect(url).toMatch(
        new RegExp(
          `^https://avatars\\.roleplayerguild\\.com/${keys[0]}\\?v=[0-9a-f-]+$`,
        ),
      );
    }
    expect(second).not.toBe(first);

    // The small size's URL keeps the version
    const user = presentUser({ ...fake.users[0], slug: "owner" } as any)!;
    expect(user.avatar_url_sm).toBe(
      second.replace(`/${owner}.webp`, `/32/${owner}.webp`),
    );
  });

  // A member can set avatar_url to any URL, so the delete never reads it.
  it("empties the slot by the user's id, whatever avatar_url names", async () => {
    const user = fake.users.find((u) => u.id === owner)!;
    user.avatar_url = `https://avatars.roleplayerguild.com/here-avatars/${other}.webp`;
    fake.objects.add(`avatars/here-avatars/${owner}.webp`);
    fake.objects.add(`avatars/here-avatars/${other}.webp`);

    await removeAvatar(owner);

    expect(fake.events).toEqual([
      {
        op: "delete",
        bucket: "avatars",
        keys: [`here-avatars/${owner}.webp`, `here-avatars/32/${owner}.webp`],
      },
      { op: "avatar_url", userId: owner, url: "" },
    ]);
    expect(hasObject("avatars", `here-avatars/${other}.webp`)).toBe(true);
  });
});

describe("removeUploads", () => {
  it("takes down every live image the account holds and empties its slot", async () => {
    const live = [addImage({ user_id: owner }), addImage({ user_id: owner })];
    addImage({ user_id: owner, deleted_at: new Date() });
    const others = addImage({ user_id: other });
    for (const image of [...live, others]) {
      fake.objects.add(`images/${keyOf(image)}`);
    }
    fake.objects.add(`avatars/here-avatars/${owner}.webp`);

    await expect(removeUploads(owner)).resolves.toEqual({ images: 2 });

    for (const image of live) {
      expect(image.deleted_at).not.toBeNull();
      expect(hasObject("images", keyOf(image))).toBe(false);
    }
    expect(hasObject("avatars", `here-avatars/${owner}.webp`)).toBe(false);
    expect(fake.users.find((u) => u.id === owner)!.avatar_url).toBe("");
    expect(hasObject("images", keyOf(others))).toBe(true);
    expect(others.deleted_at).toBeNull();
    expect(fake.events).toContainEqual({
      op: "hide",
      ids: live.map((i) => i.id),
    });
  });
});

// Intent: an image's charge belongs to whichever account holds its row after
// a merge, because the caps read the same rows the merge would move.
// Why it exists: the caps are only as good as the record they count. Today
// server/db/admin.ts#mergeUsers returns before it writes anything, so a merge
// moves no images; if it is revived and moves them, the charge moves too.
// Scenario: an admin merges a husk account that is at its image cap.
describe("a merge", () => {
  it("leaves each image charged to the account that holds its row", async () => {
    for (let i = 0; i < QUOTA.images; i++) addImage({ user_id: other });

    await mergeUsers({ mainId: owner, huskId: other });

    for (const userId of [owner, other]) {
      const held = fake.images.filter((image) => image.user_id === userId);
      const refused = await checkImageQuota(userId).then(
        () => false,
        (err) => err instanceof StorageQuotaExceeded,
      );
      expect(refused, `account ${userId}`).toBe(held.length >= QUOTA.images);
    }
  });
});
