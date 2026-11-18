// The one owner of what members store in S3: album images and each account's
// avatar slot. It is the only file that imports server/s3.ts
// (server/parser-owners.test.ts holds that), so every object a member can
// make, and every delete, goes through the rules here.
//
// Keys: every key is built from this deployment's folder in server/config.ts
// and a row's own id or a user id. None is read from images.src or
// users.avatar_url, so no stored URL, whether a member wrote it or another
// deployment copied it, can steer a write or a delete onto another key.
//
// Album images: the images row is the record of its object. storeImage
// charges the owner's caps and inserts the row before the PUT, and
// removeImages deletes the object before it hides the row. So every object
// that may exist has a live row that its owner and staff can find and delete.
//
// Avatars: each account has one fixed pair of keys, which a replace
// overwrites. An account holds at most one avatar pair, so avatars need no
// record and no cap.

import assert from "node:assert";
import { v7 as uuidv7 } from "uuid";
// 1st
import * as belt from "./belt";
import * as config from "./config";
import { lockStanding, whenItFits } from "./db/send_budget";
import {
  exactlyOneRow,
  maybeOneRow,
  pool,
  withPgPoolTransaction,
  type PgClientInTransaction,
} from "./db/util";
import type { Encoded } from "./imaging";
import { deleteObjects, putObject } from "./s3";

// The trailing window of the hourly cap
const HOUR_SECONDS = 60 * 60;

// Every extension an album image's key has had. Until 2023 it was the upload's
// own format (png, jpg or gif); since then AVIF bytes went under .avif, then
// .webp, then .avif again. A row does not record which, so a removal deletes
// the key for each.
const IMAGE_EXTENSIONS = ["avif", "webp", "png", "jpg", "gif"] as const;

/**
 * An upload refused because it would take its owner past a cap in
 * config.IMAGE_QUOTA. Nothing was written. The message is meant for the member.
 */
export class StorageQuotaExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageQuotaExceeded";
  }
}

////////////////////////////////////////////////////////////
// Keys

function imageBucket(): string {
  assert(config.S3_IMAGE_BUCKET, "S3_IMAGE_BUCKET is not set");
  return config.S3_IMAGE_BUCKET;
}

function avatarBucket(): string {
  assert(config.S3_AVATAR_BUCKET, "S3_AVATAR_BUCKET is not set");
  return config.S3_AVATAR_BUCKET;
}

function imageKey(imageId: string, ext: string): string {
  assert(belt.isValidUuid(imageId), `not an image id: ${imageId}`);
  return `${config.S3_IMAGE_PREFIX}/users/${imageId}.${ext}`;
}

// Each key the image's object may sit under
function imageKeys(imageId: string): string[] {
  return IMAGE_EXTENSIONS.map((ext) => imageKey(imageId, ext));
}

function avatarKeys(userId: number): { normal: string; small: string } {
  assert(Number.isInteger(userId), `not a user id: ${userId}`);
  const prefix = config.S3_AVATAR_PREFIX;
  return {
    normal: `${prefix}/${userId}.webp`,
    small: `${prefix}/32/${userId}.webp`,
  };
}

////////////////////////////////////////////////////////////
// Album images

// Throws StorageQuotaExceeded when one more image of `bytes` would take the
// owner past a cap. The caller holds lockSender, so no other upload by the
// owner can pass the same check before this one inserts its row.
async function refuseOverQuota(
  client: PgClientInTransaction,
  ownerId: number,
  trusted: boolean,
  bytes: number,
): Promise<void> {
  const quota = trusted
    ? config.IMAGE_QUOTA.trusted
    : config.IMAGE_QUOTA.untrusted;

  const usage = await client
    .query<{ images: number; bytes: string }>(
      `
      SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS images,
        COALESCE(SUM(bytes) FILTER (WHERE deleted_at IS NULL), 0)::bigint AS bytes
      FROM images
      WHERE user_id = $1
    `,
      [ownerId],
    )
    .then(exactlyOneRow);
  if (usage.images + 1 > quota.images) {
    throw new StorageQuotaExceeded(
      `You can keep at most ${quota.images} images. Delete some to upload more.`,
    );
  }
  if (Number(usage.bytes) + bytes > quota.bytes) {
    throw new StorageQuotaExceeded(
      `Your images can take up at most ${Math.floor(quota.bytes / 1e6)} MB. ` +
        `Delete some to upload more.`,
    );
  }

  // Deleted rows count, so deleting and uploading again does not get around
  // the hourly cap.
  const recent = await client
    .query<{ created_at: Date }>(
      `
      SELECT created_at
      FROM images
      WHERE user_id = $1
        AND created_at > NOW() - make_interval(secs => $2)
      ORDER BY created_at
    `,
      [ownerId, HOUR_SECONDS],
    )
    .then((res) => res.rows.map((row) => ({ cost: 1, ...row })));
  const retryAt = whenItFits(recent, 1, quota.perHour, HOUR_SECONDS);
  if (retryAt) {
    throw new StorageQuotaExceeded(
      `You can upload ${quota.perHour} images per hour. ` +
        `Try again in ${belt.waitLength(retryAt)}.`,
    );
  }
}

/**
 * Throws StorageQuotaExceeded when the owner is already at a cap, so a route
 * can refuse before it reads and transcodes the upload. It bounds nothing:
 * uploads that pass it together still meet the locked check in storeImage,
 * which decides.
 */
export async function checkImageQuota(ownerId: number): Promise<void> {
  await withPgPoolTransaction(pool, async (client) => {
    const { trusted } = await lockStanding(client, ownerId);
    // The smallest upload there is
    await refuseOverQuota(client, ownerId, trusted, 1);
  });
}

/**
 * Stores an album image and its row. Returns false, having written nothing,
 * when ownerId does not own the album. Throws StorageQuotaExceeded, having
 * written nothing, when the image would take the owner past a cap.
 *
 * The row is inserted and committed before the PUT, so a crash in between
 * leaves a charged row with a broken thumbnail, which its owner can delete,
 * and never an object without a row.
 */
export async function storeImage({
  ownerId,
  albumId,
  description,
  image,
}: {
  ownerId: number;
  albumId: number;
  description: string | null;
  image: Encoded<"image/avif">;
}): Promise<boolean> {
  assert(Number.isInteger(ownerId));
  assert(Number.isInteger(albumId));
  const bucket = imageBucket();
  const imageId = uuidv7();
  const key = imageKey(imageId, "avif");
  const bytes = image.buffer.length;

  const inserted = await withPgPoolTransaction(pool, async (client) => {
    // lockSender, taken here, is the per-account lock. Uploads are not sends
    // and pay nothing to the send budget.
    const { trusted } = await lockStanding(client, ownerId);
    await refuseOverQuota(client, ownerId, trusted, bytes);
    // Copies user_id from the album, so the row only exists when ownerId
    // owns the album.
    const result = await client.query(
      `
      INSERT INTO images (id, album_id, user_id, src, mime, description, bytes)
      SELECT $1::uuid, albums.id, albums.user_id, $4::text, $5::text, $6::text, $7::int
      FROM albums
      WHERE albums.id = $2
        AND albums.user_id = $3
    `,
      [
        imageId,
        albumId,
        ownerId,
        `https://img.roleplayerguild.com/${key}`,
        image.contentType,
        description,
        bytes,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (!inserted) return false;

  try {
    await putObject(bucket, key, image.buffer, image.contentType);
  } catch (err) {
    // A failed PUT may still have stored the object, so take it down the way
    // a delete does. If S3 refuses that too, the row stays live, and its
    // owner can delete it later. Nothing orders a PUT that failed on the wire
    // after S3 took all its bytes, so S3 could still commit it after both
    // deletes.
    await removeImages(ownerId, [imageId]).catch((cleanupErr) => {
      console.error(`could not clean up image ${imageId}`, cleanupErr);
    });
    throw err;
  }

  // The owner or staff may have removed the row while the PUT ran, and their
  // delete may have reached S3 before this PUT did. Once the PUT has landed,
  // a hidden row means the object must go again.
  const row = await pool
    .query<{ deleted_at: Date | null }>(
      `
      SELECT deleted_at
      FROM images
      WHERE id = $1
    `,
      [imageId],
    )
    .then(maybeOneRow);
  if (!row || row.deleted_at) await deleteObjects(bucket, imageKeys(imageId));
  return true;
}

// Takes down each of the owner's live images among imageIds and returns how
// many it hid. A row is hidden only once S3 has confirmed its object is gone.
//
// An upload's PUT can still land after the first delete. If the upload reads
// its row before the hide, it sees the row live and leaves the object, so the
// second delete, after the hide, takes it down. If it reads the row after
// the hide, storeImage deletes the object itself. Should the second delete
// fail, the rows come back, so the object never outlives a live row.
async function removeImages(
  ownerId: number,
  imageIds: string[],
): Promise<number> {
  assert(Number.isInteger(ownerId));
  if (imageIds.length === 0) return 0;
  const bucket = imageBucket();

  const live = await pool
    .query<{ id: string }>(
      `
      SELECT id
      FROM images
      WHERE user_id = $1
        AND id = ANY($2::uuid[])
        AND deleted_at IS NULL
    `,
      [ownerId, imageIds],
    )
    .then((res) => res.rows.map((row) => row.id));
  if (live.length === 0) return 0;

  await deleteObjects(bucket, live.flatMap(imageKeys));

  const hidden = await pool
    .query<{ id: string }>(
      `
      UPDATE images
      SET deleted_at = NOW()
      WHERE user_id = $1
        AND id = ANY($2::uuid[])
        AND deleted_at IS NULL
      RETURNING id
    `,
      [ownerId, live],
    )
    .then((res) => res.rows.map((row) => row.id));
  if (hidden.length === 0) return 0;

  try {
    await deleteObjects(bucket, hidden.flatMap(imageKeys));
  } catch (err) {
    await pool.query(
      `
      UPDATE images
      SET deleted_at = NULL
      WHERE id = ANY($1::uuid[])
    `,
      [hidden],
    );
    throw err;
  }
  return hidden.length;
}

/**
 * Deletes the image's object and then hides its row, if ownerId owns it and
 * it is live. Returns whether it hid the row.
 */
export async function removeImage(
  ownerId: number,
  imageId: string,
): Promise<boolean> {
  return (await removeImages(ownerId, [imageId])) > 0;
}

////////////////////////////////////////////////////////////
// Avatars

/**
 * Puts both sizes into the account's avatar slot and points avatar_url at it.
 * Two uploads at once can leave the sizes from different uploads until the
 * next one.
 */
export async function storeAvatar(
  userId: number,
  avatar: { normal: Encoded<"image/webp">; small: Encoded<"image/webp"> },
): Promise<void> {
  const bucket = avatarBucket();
  const keys = avatarKeys(userId);
  await Promise.all([
    putObject(
      bucket,
      keys.normal,
      avatar.normal.buffer,
      avatar.normal.contentType,
    ),
    putObject(
      bucket,
      keys.small,
      avatar.small.buffer,
      avatar.small.contentType,
    ),
  ]);
  // The key stays the same, so a new version in the URL makes browsers and
  // the CDN fetch the new image instead of the one they cached.
  // server/presenters.ts#presentUser keeps it on the small size's URL.
  const url = `https://avatars.roleplayerguild.com/${keys.normal}?v=${uuidv7()}`;
  await pool.query(
    `
    UPDATE users
    SET avatar_url = $2, legacy_avatar_url = NULL
    WHERE id = $1
  `,
    [userId, url],
  );
}

/** Empties the account's avatar slot in S3, then clears its avatar. */
export async function removeAvatar(userId: number): Promise<void> {
  const keys = avatarKeys(userId);
  await deleteObjects(avatarBucket(), [keys.normal, keys.small]);
  await pool.query(
    `
    UPDATE users
    SET avatar_url = '', legacy_avatar_url = NULL
    WHERE id = $1
  `,
    [userId],
  );
}

////////////////////////////////////////////////////////////
// Takedown

// Every live album image the account holds. It reads the rows of a nuked
// account too, which the album pages hide, since a nuke leaves the objects up.
async function liveImageIds(userId: number): Promise<string[]> {
  return pool
    .query<{ id: string }>(
      `
      SELECT id
      FROM images
      WHERE user_id = $1
        AND deleted_at IS NULL
    `,
      [userId],
    )
    .then((res) => res.rows.map((row) => row.id));
}

/** How many album images removeUploads would take down, for its confirm page. */
export async function countLiveImages(userId: number): Promise<number> {
  return (await liveImageIds(userId)).length;
}

/**
 * Takes down every live album image the account holds and empties its avatar
 * slot: the staff action for a spam account's uploads. It is apart from nuke,
 * because unnuke cannot bring a deleted object back.
 */
export async function removeUploads(
  userId: number,
): Promise<{ images: number }> {
  const ids = await liveImageIds(userId);
  const images = await removeImages(userId, ids);
  await removeAvatar(userId);
  return { images };
}
