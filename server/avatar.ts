// 1st party
import * as config from "./config";
import { transcodeAvatar } from "./imaging";
import { uploadToS3 } from "./s3";
import { v7 as uuidv7 } from "uuid";

// Uploads s3 avatars, returns url of the large avatar.
// server/imaging.ts#transcodeAvatar turns the upload into both WebP sizes, and
// throws ImageRefused for a file it will not take.
export const handleAvatarTransformAndUpload = async (
  input: Buffer,
): Promise<string> => {
  if (!config.AWS_KEY || !config.AWS_SECRET) {
    throw new Error("Avatar upload not configured");
  }

  const { normal, small } = await transcodeAvatar(input);
  const uuid = uuidv7();

  // Upload both sizes in parallel
  const [normalResult] = await Promise.all([
    uploadToS3({ type: "avatar", uuid, size: "normal", ...normal }),
    uploadToS3({ type: "avatar", uuid, size: "small", ...small }),
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
