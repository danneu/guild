import { Result } from "./result";

// No port
// Not ipv4 or ipv6
// Hostname is lowercase
export type NormalizedUrl = URL & { readonly __brand: unique symbol };

/**
 * Validates and normalizes a URL
 * Normalize a URL so that it can be used as a key in R2
 */
export function validateAndNormalizeUrl(
  urlString: string,
): Result<NormalizedUrl> {
  try {
    // Basic validation
    if (!urlString || typeof urlString !== "string") {
      return Result.err(new Error("Invalid URL"));
    }

    // Parse URL directly (should already be decoded by caller)
    const url = new URL(urlString.trim());

    // Only allow http(s)
    if (!["http:", "https:"].includes(url.protocol)) {
      return Result.err(new Error("Invalid URL protocol"));
    }

    // Reject URL with a port, if provided
    if (url.port) {
      return Result.err(new Error("URL with port is not allowed"));
    }

    url.hostname = url.hostname.toLowerCase();

    // Block URL with colon or brackets
    // This blocks urls that look like ipv6
    if (
      url.hostname.includes(":") ||
      url.hostname.includes("[") ||
      url.hostname.includes("]")
    ) {
      return Result.err(new Error("Invalid hostname"));
    }

    // Block hostnames that are only numbers or end in numbers
    // This also blocks ipv4
    // http://abc.123
    // http://123
    // http://127.0.0.1
    if (/\.?\d+$/.test(url.hostname)) {
      return Result.err(new Error("Invalid hostname"));
    }

    // Don't save guild images
    if (["roleplayerguild.com"].includes(url.hostname)) {
      return Result.err(new Error("Invalid hostname"));
    }

    // Merge consecutive slashes
    url.pathname = url.pathname.replace(/\/+/g, "/");

    // Ignore localhost
    if (url.hostname === "localhost") {
      return Result.err(new Error("Invalid hostname"));
    }

    // Return normalized URL
    return Result.ok(url as NormalizedUrl);
  } catch (error) {
    return Result.err(new Error("Invalid URL string", { cause: error }));
  }
}
