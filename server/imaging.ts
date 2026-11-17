// The one owner of image decoding, and the only non-test file that imports
// sharp (server/parser-owners.test.ts holds that). Member uploads reach native
// decoders here, so this module decides which decoders run, how many pixels an
// upload may decode to, and how many transcodes run at once. It exports the
// transcodes the app does and returns bytes; storing them is the caller's job.

import sharp from "sharp";

// Block every libvips loader for the whole process, then allow back the
// buffer loaders for the formats members upload. SVG, TIFF, HEIF/AVIF and the
// rest never see member bytes, so an advisory in one of them does not apply
// here. libvips names its GIF loader after libnsgif.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadWebpBuffer",
    "VipsForeignLoadNsgifBuffer",
  ],
});

// The bounds below are sized against the VM memory in fly.toml. One running
// transcode has to fit beside the idle app and the upload bytes that
// server/upload.ts#uploadBudget lets wait. The album's AVIF encode costs the
// most, and its cost follows ALBUM_MAX_EDGE far more than the input size, so
// the edge and the one slot decide the sum.
//
// Measured in November 2026 on the production image (node:23-alpine, musl,
// sharp 0.35.5 with libvips 8.18.7, 2 CPUs), as peak RSS. The server with
// every module loaded, but no data and no traffic, idles at about 166 MB on
// x64. One album encode of a 16 to 25 MP photo adds at most about 96 MB at a
// 1280 edge, a square photo costing the most, against 190 MB at 1920 and
// 230 MB at 2048. An avatar adds 7 to 44 MB, a 25 MP animation included. So
// the idle app, one album encode at 1280 and a full uploadBudget come to about
// 390 MB, which leaves the rest of the VM for cached rows, traffic and the
// kernel.

/**
 * The most pixels one upload may decode to, every frame of an animated avatar
 * counted. sharp refuses a larger image from its header, before decoding.
 */
const MAX_INPUT_PIXELS = 25_000_000;
/** The longest edge of a stored album image. Larger uploads are shrunk. */
const ALBUM_MAX_EDGE = 1280;
/**
 * sharp checks this only while it computes pixels: it stops a slow decode or
 * resize, but not the encoder, whose work the edge and the cap bound.
 */
const TRANSCODE_TIMEOUT_SECONDS = 15;
/**
 * Transcodes that may wait behind the running one before more are refused.
 * The timeout does not count time spent waiting, so this bounds the wait.
 */
const MAX_WAITING_TRANSCODES = 2;

/** A transcode this module refused, with a message meant for the member. */
export class ImageRefused extends Error {}

/**
 * The file is not an image this module takes: a refused format, over the
 * pixel cap, corrupt, or not an image at all.
 */
export class UnsupportedImage extends ImageRefused {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnsupportedImage";
  }
}

/** Too many transcodes already wait for the slot. */
export class ImagingBusy extends ImageRefused {
  constructor() {
    super(
      "Too many images are being processed right now. Try again in a minute.",
    );
    this.name = "ImagingBusy";
  }
}

/**
 * Runs one job at a time, in arrival order, and refuses a job with
 * ImagingBusy when maxWaiting jobs already wait.
 */
export class Slot {
  #running = false;
  #waiting: (() => void)[] = [];

  constructor(readonly maxWaiting: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.#running) {
      if (this.#waiting.length >= this.maxWaiting) throw new ImagingBusy();
      // The job that finishes hands the slot over without clearing #running.
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#running = true;
    }
    try {
      return await job();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running = false;
    }
  }
}

// One per process: the bounds above are sized for a single running transcode.
const slot = new Slot(MAX_WAITING_TRANSCODES);

const MEGAPIXELS = `${MAX_INPUT_PIXELS / 1e6} megapixels`;

export type Encoded<T extends string> = { buffer: Buffer; contentType: T };

/**
 * The two avatar sizes as WebP, animation kept. One slot job encodes both in
 * turn, so the two never hold decoded frames at once.
 */
export async function transcodeAvatar(input: Buffer): Promise<{
  normal: Encoded<"image/webp">;
  small: Encoded<"image/webp">;
}> {
  const refusal =
    `Could not use that image. Upload a JPEG, PNG, WebP or GIF of at most ` +
    `${MEGAPIXELS}, counting every frame of an animation.`;
  return slot.run(async () => ({
    normal: await avatarSize(input, 300, 400, refusal),
    small: await avatarSize(input, 64, 64, refusal),
  }));
}

async function avatarSize(
  input: Buffer,
  width: number,
  height: number,
  refusal: string,
): Promise<Encoded<"image/webp">> {
  const buffer = await encode(refusal, () =>
    // All frames, so the pixel cap counts each one and animation is kept.
    open(input, { animated: true })
      .resize({ width, height, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 100, effort: 4, smartSubsample: true }),
  );
  return { buffer, contentType: "image/webp" };
}

/**
 * An album image as AVIF, shrunk to ALBUM_MAX_EDGE. Only the first frame of
 * an animation is decoded and kept.
 */
export async function transcodeAlbumImage(
  input: Buffer,
): Promise<Encoded<"image/avif">> {
  const refusal =
    `Could not use that image. Upload a JPEG, PNG, WebP or GIF of at most ` +
    `${MEGAPIXELS}.`;
  const buffer = await slot.run(() =>
    encode(refusal, () =>
      open(input, { animated: false })
        .resize({
          width: ALBUM_MAX_EDGE,
          height: ALBUM_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .avif({ quality: 80, effort: 4 }),
    ),
  );
  return { buffer, contentType: "image/avif" };
}

// Every pipeline starts here, so none skips the pixel cap or the timeout.
function open(input: Buffer, options: { animated: boolean }): sharp.Sharp {
  return sharp(input, {
    animated: options.animated,
    limitInputPixels: MAX_INPUT_PIXELS,
  }).timeout({ seconds: TRANSCODE_TIMEOUT_SECONDS });
}

// sharp rejects with a plain Error for every way an upload can fail: no
// allowed loader matches, the header is over the cap or corrupt, the pixel
// data is bad, or the timeout fired. Each means the upload cannot be used.
async function encode(
  refusal: string,
  pipeline: () => sharp.Sharp,
): Promise<Buffer> {
  try {
    return await pipeline().toBuffer();
  } catch (err) {
    throw new UnsupportedImage(refusal, { cause: err });
  }
}
