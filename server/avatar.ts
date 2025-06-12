// 3rd party
import sharp from 'sharp'
import { PassThrough, Readable } from 'stream'
import { v7 as uuidv7 } from 'uuid'
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
// 1st party
import * as config from './config'

// Uploads s3 avatars, returns url of the large avatar.
export const handleAvatarTransformAndUpload = async (fullInPath: string): Promise<string> => {
    if (!config.AWS_KEY || !config.AWS_SECRET) {
        throw new Error('Avatar upload not configured')
    }

    const uuid = uuidv7()
    const folderName = config.NODE_ENV === 'production' ? 'production' : 'development';
    
    // Create S3 client
    const s3Client = new S3Client({
        region: 'us-east-1',
        credentials: {
            accessKeyId: config.AWS_KEY,
            secretAccessKey: config.AWS_SECRET,
        },
    });

    // Helper function to upload a stream to S3
    const uploadToS3 = async (
        stream: Readable,
        objectName: string
    ): Promise<string> => {
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: config.S3_AVATAR_BUCKET,
                Key: objectName,
                Body: stream,
                ContentType: 'image/avif',
                CacheControl: 'max-age=31536000', // 1 year
            },
            partSize: 1024 * 1024 * 5, // 5MB parts
            queueSize: 4,
        });

        const result = await upload.done();
        // https://avatars.roleplayerguild.com/{production|development}/{uuid}.avif
        const s3url = new URL(result.Location!)
        const guildurl = new URL('https://avatars.roleplayerguild.com')
        guildurl.pathname = s3url.pathname
        return guildurl.toString()
    };

    // Read the image into a buffer first (more efficient for multiple operations)
    const imageBuffer = await sharp(fullInPath).toBuffer();

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
            const stream = new PassThrough();
            stream.end(buffer);
            return uploadToS3(stream, `${folderName}/${uuid}.avif`);
        });

    const smallPromise = sharp(imageBuffer)
        .resize({
            width: 32,
            height: 32,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .avif({
            quality: 80,
            effort: 4,
        })
        .toBuffer()
        .then(buffer => {
            const stream = new PassThrough();
            stream.end(buffer);
            return uploadToS3(stream, `${folderName}/32/${uuid}.avif`);
        });

    // Upload both sizes in parallel
    const [normalUrl] = await Promise.all([normalPromise, smallPromise]);

    console.log('normalUrl', normalUrl)
    const url = new URL(normalUrl)
    console.log('url', url)

    // Return the large avatar URL (matching original behavior)
    return normalUrl;
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