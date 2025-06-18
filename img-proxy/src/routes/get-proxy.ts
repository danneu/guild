import { canonicalizeUrlToKey } from "../util/canonicalize-url";
import { validateAndNormalizeUrl } from "../util/normalize-url";
import type { Env } from "../types";
import { MAX_IMAGE_SIZE } from "../config";
import { checkImageMagicBytes } from "../util/check-image-magic-bytes";

const securityHeaders = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};

// In-memory cache for pending image fetches to deduplicate concurrent requests
const pendingFetches = new Map<string, Promise<{
  imageData: ArrayBuffer;
  contentType: string;
}>>();

async function fetchImageWithDeduplication(
  validatedUrl: URL,
  request: Request,
  key: string,
): Promise<{ imageData: ArrayBuffer; contentType: string }> {
  // Check if there's already a pending fetch for this key
  const existingFetch = pendingFetches.get(key);
  if (existingFetch) {
    console.log(`Deduplicating fetch for key: ${key}`);
    return await existingFetch;
  }

  // Create new fetch promise
  const fetchPromise = (async () => {
    try {
      // Fetch the original image
      const imageResponse = await fetch(validatedUrl, {
        headers: {
          // Use the same user agent as the original request
          "User-Agent":
            request.headers.get("user-agent") ||
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          // Referrer should be the image URL
          Referer: validatedUrl.origin + validatedUrl.pathname,
        },
        // Add timeout
        signal: AbortSignal.timeout(30000), // 30 seconds
      });

      if (!imageResponse.ok) {
        throw new Error(`HTTP ${imageResponse.status}: ${imageResponse.statusText}`);
      }

      // Validate content type
      const contentType = imageResponse.headers.get("content-type");
      if (!contentType || !contentType.startsWith("image/")) {
        throw new Error("URL does not point to an image");
      }

      // Check size
      const contentLength = imageResponse.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
        throw new Error("Image too large");
      }

      // Get the image data
      const imageData = await imageResponse.arrayBuffer();

      // Verify actual size
      if (imageData.byteLength > MAX_IMAGE_SIZE) {
        throw new Error("Image too large");
      }

      // Verify image format
      const imageType = checkImageMagicBytes(imageData);
      if (!imageType) {
        throw new Error("Invalid image format");
      }

      return { imageData, contentType };
    } finally {
      // Always clean up the promise from cache when done
      pendingFetches.delete(key);
    }
  })();

  // Store the promise in cache
  pendingFetches.set(key, fetchPromise);

  return await fetchPromise;
}

export default async function handleGetProxy(
  url: URL,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  const imageUrl = url.searchParams.get("url");
  console.log(
    `imageUrl: ${typeof imageUrl === "string" ? `"${imageUrl}"` : "<none>"}`,
  );

  if (!imageUrl) {
    // If no URL, Return the "not-found.webp" file from the bucket root
    const notFound = await env.R2_BUCKET.get("not-found.webp");
    if (notFound) {
      return new Response(notFound.body, {
        headers: { "Content-Type": "image/webp" },
        status: 404,
      });
    } else {
      return new Response("Not found", { status: 404 });
    }
  }

  try {
    // Validate URL
    const result = validateAndNormalizeUrl(imageUrl);
    if (!result.ok) {
      return new Response("Invalid URL", { status: 400 });
    }

    const validatedUrl = result.value;

    // Generate canonicalized key
    const key = `proxied/${canonicalizeUrlToKey(validatedUrl)}`;

    // Try to get from R2 first
    const cached = await env.R2_BUCKET.get(key);
    if (cached) {
      return new Response(cached.body, {
        headers: {
          "Content-Type": cached.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Cache-Status": "HIT",
          "X-Original-URL": validatedUrl.toString(),
        },
      });
    }

    // Fetch the image with deduplication
    const { imageData, contentType } = await fetchImageWithDeduplication(
      validatedUrl,
      request,
      key,
    );

    // Store in R2
    await env.R2_BUCKET.put(key, imageData, {
      httpMetadata: {
        contentType: contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        originalUrl: validatedUrl.toString(),
        cachedAt: new Date().toISOString(),
        contentLength: imageData.byteLength.toString(),
      },
    });

    // Return the image
    return new Response(imageData, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Cache-Status": "MISS",
        "X-Original-URL": validatedUrl.toString(),
      },
    });
  } catch (error) {
    console.error("Proxy error:", error);

    if (error instanceof Error) {
      // Check if it's a timeout
      if (error.name === "AbortError") {
        return new Response("Request timeout", { status: 504 });
      }

      // Handle specific error messages from fetchImageWithDeduplication
      if (error.message.startsWith("HTTP ")) {
        const statusMatch = error.message.match(/HTTP (\d+):/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 500;
        return new Response(`Failed to fetch image: ${error.message}`, { status });
      }

      if (error.message === "URL does not point to an image") {
        return new Response(error.message, { status: 400 });
      }

      if (error.message === "Image too large") {
        return new Response(error.message, { status: 413 });
      }

      if (error.message === "Invalid image format") {
        return new Response(error.message, { status: 400 });
      }
    }

    return new Response("Failed to proxy image", { status: 500 });
  }
}
