-- The stored size of each album image. server/storage.ts#storeImage writes it
-- with the row and sums it over the owner's live rows against the byte cap in
-- server/config.ts#IMAGE_QUOTA.
--
-- ORDERING IS LOAD-BEARING. Apply this by hand BEFORE deploying the build that
-- reads it. That build reads and writes the column on every upload, so without
-- it every upload fails with 42703 (undefined_column). Deletes and the rest of
-- the site are unaffected.
--
-- Additive only: the previous build never reads it, and its inserts take the
-- default, so redeploying it stays a working rollback.
--
-- No backfill. Rows from before it read 0, so they count toward the image
-- count cap but not the byte cap.

ALTER TABLE images
  ADD COLUMN bytes int NOT NULL DEFAULT 0 CHECK (bytes >= 0);
