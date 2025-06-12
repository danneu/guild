import * as config from "./config";
import { PutObjectCommandInput, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export type Uploadable =
  | {
      uuid: string;
      type: "avatar";
      buffer: Buffer;
      contentType: "image/avif";
      size: "normal" | "small";
    }
  | {
      uuid: string;
      type: "album_image";
      buffer: Buffer;
      contentType: "image/avif";
    };

export type UploadResult = {
  publicUrl: string;
};

// Returns URL to uploaded file
export async function uploadToS3(
  uploadable: Uploadable,
): Promise<UploadResult> {
  if (!config.AWS_KEY || !config.AWS_SECRET) {
    throw new Error(
      `Cannot upload ${uploadable.type} to S3, AWS credentials not configured`,
    );
  }

  const client = new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: config.AWS_KEY!,
      secretAccessKey: config.AWS_SECRET!,
    },
  });

  let params: PutObjectCommandInput;
  switch (uploadable.type) {
    case "album_image": {
      const envFolder = config.NODE_ENV === "production" ? "prod" : "dev";
      const Key = `${envFolder}/users/${uploadable.uuid}.avif`;
      params = {
        Bucket: config.S3_IMAGE_BUCKET,
        Key,
        Body: uploadable.buffer,
        ContentType: "image/avif",
        CacheControl: "max-age=31536000", // 1 year
      };
      break;
    }
    case "avatar": {
      const folderName =
        config.NODE_ENV === "production" ? "production" : "development";
      const Key =
        uploadable.size === "normal"
          ? `${folderName}/${uploadable.uuid}.avif`
          : `${folderName}/32/${uploadable.uuid}.avif`;
      params = {
        Bucket: config.S3_AVATAR_BUCKET,
        Key,
        Body: uploadable.buffer,
        ContentType: "image/avif",
        CacheControl: "max-age=31536000", // 1 year
      };
      break;
    }
    default: {
      const exhaustive: never = uploadable;
      throw new Error(`Unknown uploadable type: ${exhaustive}`);
    }
  }

  const upload = new Upload({ client, params });

  const result = await upload.done();
  const s3Url = new URL(result.Location!);
  let publicUrl: string;
  switch (uploadable.type) {
    case "album_image": {
      // https://img.roleplayerguild.com/{prod|dev}/users/{uuid}.avif
      console.log("s3Url", s3Url);
      const guildUrl = new URL("https://img.roleplayerguild.com");
      console.log("guildUrl before", guildUrl)
      guildUrl.pathname = s3Url.pathname;
      console.log('guildUrl after', guildUrl)
      publicUrl = guildUrl.toString();
      break;
    }
    case "avatar": {
      // normal: https://avatars.roleplayerguild.com/{production|development}/{uuid}.avif
      // small:  https://avatars.roleplayerguild.com/{production|development}/32/{uuid}.avif
      console.log("s3Url", s3Url);
      const guildUrl = new URL("https://avatars.roleplayerguild.com");
      guildUrl.pathname = s3Url.pathname;
      publicUrl = guildUrl.toString();
      break;
    }
    default: {
      const exhaustive: never = uploadable;
      throw new Error(`Unknown uploadable type: ${exhaustive}`);
    }
  }

  return { publicUrl };
}
