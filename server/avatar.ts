// 1st party
import * as config from "./config";
import { transcodeAvatar } from "./imaging";
import { storeAvatar } from "./storage";

// Makes the upload the account's avatar.
// server/imaging.ts#transcodeAvatar turns the upload into both WebP sizes, and
// throws ImageRefused for a file it will not take. server/storage.ts#storeAvatar
// puts them in the account's avatar slot and points avatar_url at it.
export const handleAvatarTransformAndUpload = async (
  userId: number,
  input: Buffer,
): Promise<void> => {
  if (!config.AWS_KEY || !config.AWS_SECRET) {
    throw new Error("Avatar upload not configured");
  }

  await storeAvatar(userId, await transcodeAvatar(input));
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
