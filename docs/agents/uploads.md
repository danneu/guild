# Uploads, images and S3

Read this before you parse a file upload, decode or resize an image, or
store, remove or link an album image or avatar. `AGENTS.md` links here.

## Parsing an upload

- Parse a file upload only through `server/upload.ts#withUpload`, and call it
  after the route's own authorization check.
- It keeps the file in memory, so no temp file exists, and it draws on one
  byte budget per process.
- A test fails if any other file imports koa-body or formidable.

## Decoding an image

- Decode an uploaded image only through the transcodes `server/imaging.ts`
  exports.
- It blocks every libvips loader but the few formats members upload, caps the
  pixels an upload may decode to, and runs one transcode at a time.
- It throws `ImageRefused`, which the route shows as a flash.
- A test fails if any other file imports sharp.

## Storing and removing

- Store or remove a member's album image or avatar only through the exports
  of `server/storage.ts`. It is the only file that imports `server/s3.ts`,
  which is the only file that imports the S3 SDK. A test fails on any other
  importer.
- Each S3 send in `server/s3.ts` aborts at a deadline. A call that failed or
  timed out may still have taken effect, so `server/storage.ts` treats it as
  unclear.
- Every key is built from this deployment's `S3_IMAGE_PREFIX` or
  `S3_AVATAR_PREFIX` and a row id or user id, never read from a stored URL.
- An album image's row is the record of its object. `storeImage` takes
  lockSender, checks the owner's caps in `server/config.ts#IMAGE_QUOTA`, and
  commits the row before the PUT.
- Over a cap it throws `StorageQuotaExceeded` and writes nothing. The route
  shows that as a flash.
- `removeImage` deletes the object before it hides the row.
- Uploads are not sends and pay nothing to the send budget.
- Each account has one avatar slot, which a new avatar overwrites.

## Takedown

Staff take down an account's uploads with REMOVE_UPLOADS. It stays apart from
nuke, because unnuke cannot bring back a deleted object. A nuke only hides the
account's albums and images from the pages that list them (see
[read-scope.md](read-scope.md#nuked-authors)), so their objects stay up until
staff remove them.
