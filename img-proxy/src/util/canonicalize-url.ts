// This must run after validateAndNormalizeUrl

import { NormalizedUrl } from "./normalize-url";

/**
 * Canonicalizes a URL into a safe R2 key
 * Examples:
 * - https://example.com/image.jpg -> example.com/image.jpg
 * - https://example.com/path/to/image.jpg?v=123 -> example.com/path/to/image.jpg/v=123
 * - https://example.com:443/image.jpg -> example.com/image.jpg
 */
export function canonicalizeUrlToKey(url: NormalizedUrl): string {
  // Start with hostname
  let key = url.hostname;

  // Remove default ports
  // if (
  //   (url.protocol === "https:" && url.port === "443") ||
  //   (url.protocol === "http:" && url.port === "80")
  // ) {
  //   // Port is already excluded from hostname
  // } else if (url.port) {
  //   key += `:${url.port}`;
  // }

  // Add pathname (remove leading slash)
  if (url.pathname && url.pathname !== "/") {
    key += url.pathname;
  }

  // Add search params if present
  if (url.search) {
    // Sort params for consistency
    const params = new URLSearchParams(url.search);
    const sortedParams = new URLSearchParams([...params].sort());
    key += `/${sortedParams.toString()}`;
  }

  // Clean up the key
  key = key
    // Replace multiple slashes with single slash
    .replace(/\/+/g, "/")
    // Remove trailing slashes
    .replace(/\/$/, "")
    // Replace characters that might cause issues in R2
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_")
    // Ensure no double dots (directory traversal)
    .replace(/\.\./g, "_") // I think new URL already does this
    // Limit length (R2 has a 1024 byte limit for keys)
    .substring(0, 800);

  return key;
}
