// 3rd party
import sharp from 'sharp'
// 1st party
import * as config from './config'
import { uploadToS3 } from './s3';
import { v7 as uuidv7 } from 'uuid'

// Uploads s3 avatars, returns url of the large avatar.
export const handleAvatarTransformAndUpload = async (fullInPath: string): Promise<string> => {
    if (!config.AWS_KEY || !config.AWS_SECRET) {
        throw new Error('Avatar upload not configured')
    }

    // Read the image into a buffer first (more efficient for multiple operations)
    const imageBuffer = await sharp(fullInPath).toBuffer();

    // both images share a uuid
    const uuid = uuidv7()

    // Create resize operations from the buffer
    const normalPromise = sharp(imageBuffer)
        .resize({
            width: 300,
            height: 400,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .avif({
            quality: 80,
            effort: 4,
        })
        .toBuffer()
        .then(buffer => {
            return uploadToS3({
                type: 'avatar',
                uuid,
                buffer,
                contentType: 'image/avif',
                size: 'normal',
            });
        });

    const smallPromise = sharp(imageBuffer)
    // they will be displayed as 32x32
        .resize({
            width: 64,
            height: 64,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .avif({
            quality: 80,
            effort: 4,
        })
        .toBuffer()
        .then(buffer => {
            return uploadToS3({
                type: 'avatar',
                uuid,
                buffer,
                contentType: 'image/avif',
                size: 'small',
            });
        });

    // Upload both sizes in parallel
    const [normalResult] = await Promise.all([normalPromise, smallPromise]);

    // Return the large avatar URL (matching original behavior)
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