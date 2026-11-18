// The app's S3 calls: put one object and delete objects, each by bucket and
// key. This is the only file that imports the S3 SDK, and server/storage.ts,
// which decides every key, is the only file that imports this one
// (server/parser-owners.test.ts holds both).
//
// Every send passes within(), which aborts the request at CALL_TIMEOUT_MS,
// retries included. An upload or a removal waits on S3, so a stalled S3 fails
// it instead of holding it open. A call that failed, timed out included, may
// still have taken effect, and server/storage.ts treats it that way.

import {
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import * as config from "./config";

// The most keys one DeleteObjects request takes.
const MAX_KEYS_PER_DELETE = 1000;

// How long one S3 request gets, retries included
const CALL_TIMEOUT_MS = 30_000;

let client: S3Client | undefined;

function s3(): S3Client {
  if (!config.AWS_KEY || !config.AWS_SECRET) {
    throw new Error("Cannot reach S3: AWS_KEY and AWS_SECRET are not set");
  }
  client ??= new S3Client({
    region: "us-east-1",
    credentials: {
      accessKeyId: config.AWS_KEY,
      secretAccessKey: config.AWS_SECRET,
    },
    // A backstop for a send that leaves out within(). These limit each
    // attempt, and requestTimeout only while the socket is idle, so they
    // are no deadline for the call.
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: CALL_TIMEOUT_MS,
    },
  });
  return client;
}

// The options for one send: an abort at the deadline, which the SDK does not
// retry.
function within(): { abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) };
}

/** Stores body at key, public and cached for a year, replacing any object. */
export async function putObject(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "max-age=31536000", // 1 year
    }),
    within(),
  );
}

/**
 * Deletes each key, whether it holds an object or not. Returns only once S3
 * confirms every key: DeleteObjects answers 200 even when it fails some keys,
 * and lists those in Errors, so this throws on any.
 */
export async function deleteObjects(
  bucket: string,
  keys: string[],
): Promise<void> {
  for (let start = 0; start < keys.length; start += MAX_KEYS_PER_DELETE) {
    const batch = keys.slice(start, start + MAX_KEYS_PER_DELETE);
    const result = await s3().send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
      within(),
    );
    const failed = result.Errors ?? [];
    if (failed.length > 0) {
      const first = failed[0]!;
      throw new Error(
        `S3 did not delete ${failed.length} of ${batch.length} keys, ` +
          `first ${first.Key}: ${first.Code} ${first.Message}`,
      );
    }
  }
}
