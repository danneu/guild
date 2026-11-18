import Router from "@koa/router";
import { Encoded, ImageRefused, transcodeAlbumImage } from "../imaging";
import * as storage from "../storage";
import { StorageQuotaExceeded } from "../storage";
import { withUpload } from "../upload";
// 1st
import * as belt from "../belt";
import * as db from "../db";
import * as pre from "../presenters";
import * as config from "../config";
import { Context, Next } from "koa";

const router = new Router();

////////////////////////////////////////////////////////////

async function loadUser(ctx: Context, next: Next) {
  const user = await db.getUserBySlug(ctx.params.user_slug);
  pre.presentUser(user);
  ctx.assert(user, 404);
  ctx.state.user = user;
  return next();
}

// loadImage and loadAlbum find any row by id. They suit routes that only read
// and have no slug user. A route that authorizes the slug user loads with
// loadUserImage or loadUserAlbum instead.

async function loadImage(ctx: Context, next: Next) {
  ctx.assert(belt.isValidUuid(ctx.params.image_id), 404);
  const image = await db.images.getImage(ctx.params.image_id);
  pre.presentImage(image);
  ctx.assert(image, 404);
  ctx.state.image = image;
  return next();
}

async function loadAlbum(ctx: Context, next: Next) {
  ctx.assert(/^[0-9]+$/.test(ctx.params.album_id), 404);
  const album = await db.images.getAlbum(ctx.params.album_id);
  pre.presentAlbum(album);
  ctx.assert(album, 404);
  ctx.state.album = album;
  return next();
}

// The loaders for /users/:user_slug/... routes. They run after loadUser and
// 404 unless ctx.state.user owns the object, so the image or album a route
// acts on belongs to the user it authorizes.

async function loadUserImage(ctx: Context, next: Next) {
  ctx.assert(belt.isValidUuid(ctx.params.image_id), 404);
  const image = await db.images.getUserImage(
    ctx.state.user.id,
    ctx.params.image_id,
  );
  pre.presentImage(image);
  ctx.assert(image, 404);
  ctx.state.image = image;
  return next();
}

async function loadUserAlbum(ctx: Context, next: Next) {
  ctx.assert(/^[0-9]+$/.test(ctx.params.album_id), 404);
  const album = await db.images.getUserAlbum(
    ctx.state.user.id,
    Number(ctx.params.album_id),
  );
  pre.presentAlbum(album);
  ctx.assert(album, 404);
  ctx.state.album = album;
  return next();
}

////////////////////////////////////////////////////////////

function extToMime(ext: string): string | null {
  switch (ext) {
    case "gif":
      return "image/gif";
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "avif":
      return "image/avif";
    default:
      return null;
  }
}

// TODO: What is this for?
router.get("/images/:image_id.:ext", loadImage, async (ctx: Context) => {
  ctx.assert(extToMime(ctx.params.ext), 404);
  ctx.assert(extToMime(ctx.params.ext) === ctx.state.image.mime, 404);
  ctx.set("Cache-Control", "max-age=31556926");
  ctx.type = ctx.state.image.mime;
  ctx.body = ctx.state.image.blob;
});

router.get(
  "/users/:user_slug/images/:image_id",
  loadUser,
  loadUserImage,
  async (ctx: Context) => {
    await ctx.render("show_user_image", {
      ctx,
      image: ctx.state.image,
      user: ctx.state.user,
      title: "Image",
    });
  },
);

router.get("/users/:user_slug/images", loadUser, async (ctx: Context) => {
  // template: views/show_user_images.html
  const images = await db.images.getUserImages(ctx.state.user.id);
  images.forEach(pre.presentImage);
  const albums = await db.images.getUserAlbums(ctx.state.user.id);
  albums.forEach(pre.presentAlbum);
  await ctx.render("show_user_images", {
    ctx,
    images,
    albums,
    user: ctx.state.user,
    title: `${ctx.state.user.uname}'s Images`,
  });
});

////////////////////////////////////////////////////////////
// Upload

// The upload forms in views/show_album.html and views/show_user_images.html.
const IMAGE_UPLOAD = {
  file: "image",
  fields: ["description", "album_id"],
  maxFileBytes: 40e6,
} as const;

// The answer while the bucket is unset, as in development without S3.
const OFFLINE = "The upload system is currently offline. (Bucket unspecified)";

router.post("/users/:user_slug/images", loadUser, async (ctx: Context) => {
  if (!config.S3_IMAGE_BUCKET) {
    return (ctx.body = OFFLINE);
  }
  ctx.assertAuthorized(ctx.currUser, "UPLOAD_IMAGE", ctx.state.user);

  // An account already at a cap is told so before its file is read and
  // transcoded. storeImage checks again under the lock and decides.
  try {
    await storage.checkImageQuota(ctx.state.user.id);
  } catch (err) {
    if (!(err instanceof StorageQuotaExceeded)) throw err;
    ctx.flash = { message: ["danger", err.message] };
    return ctx.back("/");
  }

  const result = await withUpload(
    ctx,
    IMAGE_UPLOAD,
    async ({ fields, file }) => {
      // FIXME: Lame validation
      // fields
      const description = fields.description;
      ctx.assert(typeof description === "string", 400, "description required");
      ctx.assert(description.length <= 10000, 400, "description too long");
      const albumId = Number.parseInt(fields.album_id ?? "");
      ctx.assert(albumId, 400, "album id must be integer");
      // Before any encode or S3 write, so a foreign album_id stops here and
      // leaves no S3 object behind.
      const album = await db.images.getUserAlbum(ctx.state.user.id, albumId);
      ctx.assert(album, 404);
      // file
      ctx.assert(file, 400, 'no file with key "image" provided');

      // A file that is not an allowed image is refused here, before S3.
      let avif: Encoded<"image/avif">;
      try {
        avif = await transcodeAlbumImage(file.buffer);
      } catch (err) {
        if (!(err instanceof ImageRefused)) throw err;
        ctx.flash = { message: ["danger", err.message] };
        return ctx.back("/");
      }

      // STORE

      let stored: boolean;
      try {
        stored = await storage.storeImage({
          ownerId: ctx.state.user.id,
          albumId: album.id,
          description,
          image: avif,
        });
      } catch (err) {
        if (!(err instanceof StorageQuotaExceeded)) throw err;
        ctx.flash = { message: ["danger", err.message] };
        return ctx.back("/");
      }
      ctx.assert(stored, 404);

      // RESPOND

      ctx.flash = { message: ["success", "Image uploaded"] };
      ctx.redirect(ctx.state.user.url + "/images");
    },
  );

  if (result.kind === "too-large") {
    ctx.flash = {
      message: [
        "danger",
        `Image cannot exceed ${IMAGE_UPLOAD.maxFileBytes / 1e6} MB.`,
      ],
    };
    return ctx.back("/");
  }
});

// Deletes the image from S3, then hides its row.
router.del(
  "/users/:user_slug/images/:image_id",
  loadUser,
  loadUserImage,
  async (ctx: Context) => {
    ctx.assertAuthorized(ctx.currUser, "MANAGE_IMAGES", ctx.state.user);
    if (!config.S3_IMAGE_BUCKET) {
      ctx.body = OFFLINE;
      return;
    }
    const removed = await storage.removeImage(
      ctx.state.user.id,
      ctx.state.image.id,
    );
    ctx.assert(removed, 404);
    ctx.flash = { message: ["success", "Image deleted"] };
    ctx.redirect(ctx.state.user.url + "/images");
  },
);

// The staff takedown of a member's uploads: every album image and the avatar
// come out of S3. The GET is the confirm page, and the POST needs the field
// only that page's form sends, because S3 cannot bring the objects back.

// The confirm page's form field
const REMOVE_UPLOADS_CONFIRM = "remove-uploads";

router.get(
  "/users/:user_slug/remove-uploads",
  loadUser,
  async (ctx: Context) => {
    ctx.assertAuthorized(ctx.currUser, "REMOVE_UPLOADS", ctx.state.user);
    // template: views/confirm_remove_uploads.html
    await ctx.render("confirm_remove_uploads", {
      ctx,
      user: ctx.state.user,
      imageCount: await storage.countLiveImages(ctx.state.user.id),
      confirm: REMOVE_UPLOADS_CONFIRM,
      title: `Remove ${ctx.state.user.uname}'s uploads`,
    });
  },
);

router.post(
  "/users/:user_slug/remove-uploads",
  loadUser,
  async (ctx: Context) => {
    ctx.assertAuthorized(ctx.currUser, "REMOVE_UPLOADS", ctx.state.user);
    if (!config.S3_IMAGE_BUCKET || !config.S3_AVATAR_BUCKET) {
      ctx.body = OFFLINE;
      return;
    }
    ctx.assert(
      ctx.request.body.confirm === REMOVE_UPLOADS_CONFIRM,
      400,
      "Confirm on the Remove Uploads page.",
    );
    const { images } = await storage.removeUploads(ctx.state.user.id);
    ctx.flash = {
      message: ["success", `Removed ${images} images and the avatar`],
    };
    ctx.redirect(ctx.state.user.url);
  },
);

// albums

router.get("/albums/:album_id", loadAlbum, async (ctx: Context) => {
  const images = await db.images.getAlbumImages(ctx.state.album.id);
  images.forEach(pre.presentImage);
  await ctx.render("show_album", {
    ctx,
    user: ctx.state.album.user,
    album: ctx.state.album,
    images,
  });
});

// update album
//
// Body:
// - title: Required String
// - markup: Optional String
router.put(
  "/users/:user_slug/albums/:album_id",
  loadUser,
  loadUserAlbum,
  async (ctx: Context) => {
    // AUTHZ
    ctx.assertAuthorized(ctx.currUser, "MANAGE_IMAGES", ctx.state.user);
    // VALIDATE
    ctx
      .validateBody("title")
      .isString()
      .isLength(1, 300, "Title must be 1-300 chars");
    ctx
      .validateBody("markup")
      .toString()
      .isLength(0, 10000, "Description cannot be more than 10k chars");
    // SAVE
    const updated = await db.images.updateAlbum(
      ctx.state.user.id,
      ctx.state.album.id,
      {
        title: ctx.vals.title,
        markup: ctx.vals.markup,
      },
    );
    ctx.assert(updated, 404);
    // RESPOND
    ctx.flash = { message: ["success", "Album updated"] };
    ctx.redirect(ctx.state.album.url);
  },
);

router.post("/users/:user_slug/albums", loadUser, async (ctx: Context) => {
  ctx.assertAuthorized(ctx.currUser, "MANAGE_IMAGES", ctx.state.user);
  ctx
    .validateBody("title")
    .isString()
    .isLength(1, 300, "Title must be 1-300 chars");
  ctx
    .validateBody("markup")
    .isLength(0, 10000, "Description cannot be more than 10k chars");
  // Within the owner's album row budget
  const album = await db.images.insertAlbum({
    userId: ctx.state.user.id,
    title: ctx.vals.title,
    markup: ctx.vals.markup,
  });
  pre.presentAlbum(album);
  ctx.flash = { message: ["success", "Album created"] };
  ctx.redirect(album.url);
});

////////////////////////////////////////////////////////////

export default router;
