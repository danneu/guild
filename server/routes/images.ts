import Router from "@koa/router";
import sharp from "sharp";
import { uploadToS3 } from "../s3";
import { withUpload } from "../upload";
import { v7 as uuidv7 } from "uuid";
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

router.post("/users/:user_slug/images", loadUser, async (ctx: Context) => {
  if (!config.S3_IMAGE_BUCKET) {
    return (ctx.body =
      "The upload system is currently offline. (Bucket unspecified)");
  }
  ctx.assertAuthorized(ctx.currUser, "UPLOAD_IMAGE", ctx.state.user);

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

      const uuid = uuidv7();

      const imageResult = await sharp(file.buffer)
        .avif({
          quality: 80,
          effort: 4,
        })
        .toBuffer()
        .then((buffer) => {
          return uploadToS3({
            uuid,
            type: "album_image",
            buffer,
            contentType: "image/webp",
          });
        });

      // TODO: What happens when we try to upload a non-image file?

      // { 'Mime type': 'image/jpeg' OR 'format': 'JPEG' }
      // const data = await identify(upload.filepath)
      // const mime = identifyToMime(data)
      // if (!mime || ['image/jpeg', 'image/png', 'image/gif'].indexOf(mime) < 0) {
      //     ctx.flash = {
      //         message: ['danger', 'Invalid image format. Must be jpg, gif, png.'],
      //     }
      //     return ctx.redirect('back')
      // }

      // INSERT

      const inserted = await db.images.insertImage({
        imageId: uuid,
        ownerId: ctx.state.user.id,
        albumId: album.id,
        src: imageResult.publicUrl,
        mime: "image/avif",
        description,
      });
      ctx.assert(inserted, 404);

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

// TODO: Also delete from S3
router.del(
  "/users/:user_slug/images/:image_id",
  loadUser,
  loadUserImage,
  async (ctx: Context) => {
    ctx.assertAuthorized(ctx.currUser, "MANAGE_IMAGES", ctx.state.user);
    const deleted = await db.images.deleteImage(
      ctx.state.user.id,
      ctx.state.image.id,
    );
    ctx.assert(deleted, 404);
    ctx.flash = { message: ["success", "Image deleted"] };
    ctx.redirect(ctx.state.user.url + "/images");
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
