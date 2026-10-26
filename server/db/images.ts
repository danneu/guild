// 3rd
import createDebug from "debug";
const debug = createDebug("app:db:images");
import assert from "assert";
import Knex from "knex";
const knex = Knex({ client: "pg" });
import _ from "lodash";
// 1st
import { pool, maybeOneRow } from "./util.js";
import { DbAlbum, DbImage, DbUser } from "../dbtypes.js";

////////////////////////////////////////////////////////////

export async function getImage(uuid: string) {
  assert(typeof uuid === "string");
  return pool
    .query<DbImage & { user: Pick<DbUser, "uname" | "slug"> }>(
      `
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.id = $1
      AND deleted_at IS NULL
  `,
      [uuid],
    )
    .then(maybeOneRow);
}

// The image only if ownerId owns it. A route that authorized a user and then
// acts on one of their images loads it here, not with getImage, so the image
// it acts on belongs to the user it authorized.
export async function getUserImage(ownerId: number, uuid: string) {
  assert(Number.isInteger(ownerId));
  assert(typeof uuid === "string");
  return pool
    .query<DbImage & { user: Pick<DbUser, "uname" | "slug"> }>(
      `
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.id = $1
      AND images.user_id = $2
      AND images.deleted_at IS NULL
  `,
      [uuid, ownerId],
    )
    .then(maybeOneRow);
}

export async function getLatestImages(limit = 10) {
  debug(`[getLatestImages]`);
  return pool
    .query<DbImage & { user: Pick<DbUser, "uname" | "slug"> }>(
      `
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.deleted_at IS NULL
    ORDER BY images.created_at DESC
    LIMIT $1
  `,
      [limit],
    )
    .then((res) => res.rows);
}

export async function getUserAlbums(userId: number) {
  assert(Number.isInteger(userId));
  return pool
    .query<DbAlbum & { user: Pick<DbUser, "uname" | "slug"> }>(
      `
    SELECT
      albums.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM albums
    JOIN users ON albums.user_id = users.id
    WHERE albums.user_id = $1
    ORDER BY albums.created_at DESC
  `,
      [userId],
    )
    .then((res) => res.rows);
}

export async function getUserImages(userId: number) {
  assert(Number.isInteger(userId));
  return pool
    .query<DbImage & { user: Pick<DbUser, "uname" | "slug"> }>(
      `
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.user_id = $1
      AND images.deleted_at IS NULL
    ORDER BY images.created_at DESC
  `,
      [userId],
    )
    .then((res) => res.rows);
}

export async function getAlbumImages(albumId: number) {
  assert(Number.isInteger(albumId));
  return pool
    .query<DbImage & { user: Pick<DbUser, "uname" | "slug"> }>(
      `
    SELECT
      images.*,
      json_build_object(
        'uname', users.uname,
        'slug', users.slug
      ) "user"
    FROM images
    JOIN users ON images.user_id = users.id
    WHERE images.album_id = $1
      AND images.deleted_at IS NULL
    ORDER BY images.created_at DESC
  `,
      [albumId],
    )
    .then((res) => res.rows);
}

// Inserts into the album only if ownerId owns it, and copies the image's
// user_id from the album, so an image always has its album's owner.
// Returns false when no row was inserted.
//
// description is optional
export async function insertImage({
  imageId,
  ownerId,
  albumId,
  src,
  mime,
  description,
}: {
  imageId: string;
  ownerId: number;
  albumId: number;
  src: string;
  mime: string;
  description: string | null;
}): Promise<boolean> {
  assert(typeof imageId === "string");
  assert(Number.isInteger(ownerId));
  assert(Number.isInteger(albumId));
  assert(typeof src === "string");
  assert(
    ["image/jpeg", "image/gif", "image/png", "image/avif"].indexOf(mime) > -1,
  );
  const result = await pool.query(
    `
    INSERT INTO images (id, album_id, user_id, src, mime, description)
    SELECT $1::uuid, albums.id, albums.user_id, $4::text, $5::text, $6::text
    FROM albums
    WHERE albums.id = $2
      AND albums.user_id = $3
  `,
    [imageId, albumId, ownerId, src, mime, description],
  );
  return (result.rowCount ?? 0) > 0;
}

// Soft-deletes the image only if ownerId owns it.
// Returns false when no row matched.
//
// TODO: Also delete from S3
export async function deleteImage(
  ownerId: number,
  imageId: string,
): Promise<boolean> {
  assert(Number.isInteger(ownerId));
  assert(typeof imageId === "string");
  const result = await pool.query(
    `
    UPDATE images
    SET deleted_at = NOW()
    WHERE id = $1
      AND user_id = $2
  `,
    [imageId, ownerId],
  );
  return (result.rowCount ?? 0) > 0;
}

// markup is optional
export async function insertAlbum({
  userId,
  title,
  markup,
}: {
  userId: number;
  title: string;
  markup: string | null;
}) {
  assert(Number.isInteger(userId));
  assert(typeof title === "string");
  return pool
    .query(
      `
    INSERT INTO albums (user_id, title, markup)
    VALUES ($1, $2, $3)
    RETURNING *
  `,
      [userId, title, markup],
    )
    .then(maybeOneRow);
}

export async function getAlbum(albumId: number) {
  assert(albumId);
  return pool
    .query(
      `
    SELECT
      a.*,
      to_json(u.*) "user"
    FROM albums a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = $1
  `,
      [albumId],
    )
    .then(maybeOneRow);
}

// The album only if ownerId owns it. A route that authorized a user and then
// acts on one of their albums loads it here, not with getAlbum, so the album
// it acts on belongs to the user it authorized.
export async function getUserAlbum(ownerId: number, albumId: number) {
  assert(Number.isInteger(ownerId));
  assert(Number.isInteger(albumId));
  return pool
    .query(
      `
    SELECT
      a.*,
      to_json(u.*) "user"
    FROM albums a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = $1
      AND a.user_id = $2
  `,
      [albumId, ownerId],
    )
    .then(maybeOneRow);
}

// Generalized update function that takes an object of
// field/values to be updated. Updates the album only if ownerId owns it.
// Returns false when no row matched.
export async function updateAlbum(
  ownerId: number,
  albumId: number,
  fields: Partial<Pick<DbAlbum, "title" | "markup">>,
): Promise<boolean> {
  assert(Number.isInteger(ownerId));
  assert(Number.isInteger(albumId));
  assert(_.isPlainObject(fields));
  // Validate fields
  const WHITELIST = ["title", "markup"];
  Object.keys(fields).forEach((key) => {
    if (WHITELIST.indexOf(key) === -1) {
      throw new Error("FIELD_NOT_WHITELISTED");
    }
  });
  // Build SQL string
  const str = knex("albums")
    .where({ id: albumId, user_id: ownerId })
    .update(fields)
    .toString();
  const result = await pool.query(str);
  return (result.rowCount ?? 0) > 0;
}
