import zlib from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  ImagingBusy,
  Slot,
  UnsupportedImage,
  transcodeAlbumImage,
  transcodeAvatar,
} from "./imaging";

// These tests run the real sharp. Importing ./imaging blocks every libvips
// loader but the allowed four, for this whole worker, so fixtures are made
// from sharp's create input and encoders, which load nothing.

// Each part of a dotted version as a number, so 8.9 sorts below 8.18.
function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function atLeast(version: string | undefined, floor: string): boolean {
  if (version === undefined) return false;
  const have = versionParts(version);
  const want = versionParts(floor);
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#3366cc" },
  });
}

// An animation of one frame per colour. The frames differ, so neither the
// GIF nor the WebP encoder merges them.
function frames(width: number, height: number, colours: number[][]) {
  const raw = Buffer.alloc(width * height * 3 * colours.length);
  colours.forEach((colour, i) => {
    for (let p = 0; p < width * height; p++) {
      raw.set(colour, (i * width * height + p) * 3);
    }
  });
  return sharp(raw, {
    raw: {
      width,
      height: height * colours.length,
      channels: 3,
      pageHeight: height,
    },
  });
}

async function fixture(format: string): Promise<Buffer> {
  switch (format) {
    case "jpeg":
      return solid(32, 24).jpeg().toBuffer();
    case "png":
      return solid(32, 24).png().toBuffer();
    case "webp":
      return solid(32, 24).webp().toBuffer();
    case "gif":
      return solid(32, 24).gif().toBuffer();
    case "tiff":
      return solid(32, 24).tiff().toBuffer();
    case "avif":
      return solid(32, 24).avif().toBuffer();
    case "svg":
      return Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24">' +
          '<rect width="32" height="24" fill="#36c"/></svg>',
      );
    default:
      throw new Error(`no fixture for ${format}`);
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A valid 1-bit greyscale PNG of a few KB that decodes to width x height.
function blankPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  // Each row is a filter byte, then one bit per pixel.
  const rows = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A GIF whose canvas is width x height, with frames that each draw one
// pixel. It is a few hundred bytes, but every frame decodes to the canvas.
function sparseGif(width: number, height: number, frames: number): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x80; // a global palette of two colours
  const frame = Buffer.from([
    // Graphic control: a delay of 10 hundredths.
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    // Image descriptor: a 1x1 frame at the origin.
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // LZW data for one pixel of colour 0.
    0x02, 0x02, 0x44, 0x01, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from("GIF89a", "latin1"),
    screen,
    Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]),
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

// The width and height in an AVIF's ispe box, read from the bytes so the
// test needs no AVIF loader.
function avifSize(avif: Buffer): { width: number; height: number } {
  const at = avif.indexOf("ispe", 0, "latin1");
  expect(at).toBeGreaterThan(0);
  // The box type, then version and flags, then the two sizes.
  return {
    width: avif.readUInt32BE(at + 8),
    height: avif.readUInt32BE(at + 12),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("sharp", () => {
  // Intent: the sharp that loads here bundles no library below the release
  // that fixed its last high advisory.
  // Why it exists: sharp 0.34.2 stayed in the lockfile after advisories
  // GHSA-f88m-g3jw-g9cj (libvips GIF and TIFF loaders), GHSA-rgj7-g3m4-5g8c
  // (libheif) and GHSA-wq5f-xc86-pv6w (librsvg) covered it, and any member's
  // upload reached those decoders.
  // Scenario: a lockfile change resolves sharp back below 0.35.5.
  it("bundles libraries at or above the advisory floors", () => {
    const versions: Record<string, string | undefined> = sharp.versions;
    const floors = {
      sharp: "0.35.5",
      vips: "8.18.3",
      rsvg: "2.63.2",
      heif: "1.23.2",
    };
    const below = Object.entries(floors)
      .filter(([lib, floor]) => !atLeast(versions[lib], floor))
      .map(([lib, floor]) => `${lib} ${versions[lib]} < ${floor}`);

    expect(below).toEqual([]);
  });
});

describe("transcodeAlbumImage", () => {
  it.each(["jpeg", "png", "webp", "gif"])(
    "encodes a %s as AVIF",
    async (format) => {
      const out = await transcodeAlbumImage(await fixture(format));

      expect(out.contentType).toBe("image/avif");
      expect(avifSize(out.buffer)).toEqual({ width: 32, height: 24 });
    },
  );

  // Each refused format reaches a decoder that has had a high advisory.
  it.each(["svg", "tiff", "avif"])("refuses a %s", async (format) => {
    const input = await fixture(format);

    await expect(transcodeAlbumImage(input)).rejects.toThrow(UnsupportedImage);
    await expect(transcodeAvatar(input)).rejects.toThrow(UnsupportedImage);
  });

  it("refuses bytes that are not an image", async () => {
    await expect(
      transcodeAlbumImage(Buffer.from("not really a png")),
    ).rejects.toThrow(UnsupportedImage);
  });

  // Intent: a small file cannot decode to more pixels than the cap.
  // Why it exists: an 8000x8000 PNG of 203 KB drove the unbounded AVIF
  // encode to 1.67 GB, past the VM's memory.
  // Scenario: a member uploads a 4 KB PNG that decodes to 30 megapixels.
  it("refuses a small PNG with huge dimensions", async () => {
    const input = blankPng(6000, 5000);
    expect(input.length).toBeLessThan(10_000);

    await expect(transcodeAlbumImage(input)).rejects.toThrow(UnsupportedImage);
  });

  // Intent: a stored album image is at most 1280 px on its longest edge.
  // Why it exists: the AVIF encode's memory follows its output size. One
  // encode of a 25 MP photo took about 230 MB at a 2048 edge and 96 MB at
  // 1280, and the sizing comment in server/imaging.ts needs the smaller one
  // to fit the VM.
  // Scenario: a member uploads an image twice as wide as the edge.
  it("shrinks a wide image to the maximum edge", async () => {
    const input = await solid(2560, 40).png().toBuffer();

    const out = await transcodeAlbumImage(input);

    expect(avifSize(out.buffer)).toEqual({ width: 1280, height: 20 });
  });
});

describe("transcodeAvatar", () => {
  it.each(["jpeg", "png", "webp", "gif"])(
    "encodes a %s as WebP",
    async (format) => {
      const out = await transcodeAvatar(await fixture(format));

      expect(out.normal.contentType).toBe("image/webp");
      expect(out.small.contentType).toBe("image/webp");
      expect(await sharp(out.normal.buffer).metadata()).toMatchObject({
        format: "webp",
        width: 32,
        height: 24,
      });
    },
  );

  it("fits each size inside its box", async () => {
    const out = await transcodeAvatar(await solid(640, 480).png().toBuffer());

    expect(await sharp(out.normal.buffer).metadata()).toMatchObject({
      width: 300,
      height: 225,
    });
    expect(await sharp(out.small.buffer).metadata()).toMatchObject({
      width: 64,
      height: 48,
    });
  });

  it("keeps an animation's frames", async () => {
    const input = await frames(32, 24, [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ])
      .gif()
      .toBuffer();

    const out = await transcodeAvatar(input);

    expect(await sharp(out.normal.buffer).metadata()).toMatchObject({
      pages: 3,
    });
  });

  // Intent: the pixel cap counts every frame of an animated avatar.
  // Why it exists: the avatar decodes all frames at once, so a GIF of many
  // frames costs as much memory as one huge frame.
  // Scenario: a 600-byte GIF of 26 frames on a 1000x1000 canvas.
  it("refuses an animation whose frames together pass the cap", async () => {
    const input = sparseGif(1000, 1000, 26);
    expect(input.length).toBeLessThan(1_000);

    await expect(transcodeAvatar(input)).rejects.toThrow(UnsupportedImage);
  });
});

describe("Slot", () => {
  it("runs one job at a time, in arrival order", async () => {
    const slot = new Slot(2);
    const order: number[] = [];
    let running = 0;
    let most = 0;
    async function job(n: number) {
      running += 1;
      most = Math.max(most, running);
      order.push(n);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
    }

    await Promise.all([1, 2, 3].map((n) => slot.run(() => job(n))));

    expect(most).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it("refuses a job when maxWaiting jobs already wait", async () => {
    const slot = new Slot(1);
    const first = deferred();
    const ran: string[] = [];
    const running = slot.run(async () => {
      ran.push("first");
      await first.promise;
    });
    const waiting = slot.run(async () => {
      ran.push("waiting");
    });

    await expect(slot.run(async () => ran.push("third"))).rejects.toThrow(
      ImagingBusy,
    );
    first.resolve();
    await Promise.all([running, waiting]);

    expect(ran).toEqual(["first", "waiting"]);
  });

  it("frees the slot when a job fails", async () => {
    const slot = new Slot(1);

    const failed = slot.run(async () => {
      throw new Error("encode failed");
    });
    const next = slot.run(async () => "ran");

    await expect(failed).rejects.toThrow("encode failed");
    await expect(next).resolves.toBe("ran");
  });
});
