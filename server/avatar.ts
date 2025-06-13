// 3rd party
import sharp from "sharp";
// 1st party
import * as config from "./config";
import { uploadToS3 } from "./s3";
import { v7 as uuidv7 } from "uuid";

// Uploads s3 avatars, returns url of the large avatar.
// Converts all images to webp
export const handleAvatarTransformAndUpload = async (
  fullInPath: string,
): Promise<string> => {
  if (!config.AWS_KEY || !config.AWS_SECRET) {
    throw new Error("Avatar upload not configured");
  }

  // Get metadata to check for animation
  const metadata = await sharp(fullInPath).metadata();
  const isAnimated = !!(metadata.pages && metadata.pages > 1);

  const uuid = uuidv7();

  // Create resize operations
  const createResizedImage = async (
    width: number,
    height: number,
    size: "normal" | "small",
  ) => {
    const buffer = await sharp(fullInPath, {
      animated: isAnimated, // Preserve animation if present
    })
      .resize({
        width,
        height,
        // keep aspect ratio, don't crop, don't stretch
        fit: "inside",
        // don't enlarge images smaller than the target resize
        withoutEnlargement: true,
      })
      .webp({
        quality: 80,
        effort: 4, // 0-6, higher = better compression but slower
        // Additional options for better results:
        nearLossless: false, // Set true for higher quality at larger size
        smartSubsample: true, // Better color subsampling
      })
      .toBuffer();

    return uploadToS3({
      type: "avatar",
      uuid,
      buffer,
      contentType: "image/webp",
      size,
    });
  };

  // Upload both sizes in parallel
  const [normalResult] = await Promise.all([
    createResizedImage(300, 400, "normal"),
    createResizedImage(64, 64, "small"),
  ]);

  return normalResult.publicUrl;
};

//// jun 11 2025 - found this bit of archeology commented out at the bottom of the file.
//// gonna keep it here as a reminder for how much the ecosystem has changed since i
//// started this project.
//
// function* run() {
//   var format = yield getFormat(path.resolve('avatar.jpg'));
//   debug('format: ', format);
//   return yield readProcessWrite('avatar.jpg', 'avatar-sm.jpg');
// }
// console.log('Starting');
// var succBack = function() { console.log('OK'); };
// var errBack = function(ex) { console.log('-_-');console.error(ex); throw ex; };
// co(run).then(succBack, errBack);
