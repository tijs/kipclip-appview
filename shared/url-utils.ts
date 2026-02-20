/**
 * Shared URL utilities for duplicate detection.
 * Works in both Deno (backend) and browser (frontend).
 */

/**
 * Extract the base URL (scheme + host + path) from a URL string,
 * stripping query parameters and fragments.
 * Returns null for invalid URLs.
 */
export function getBaseUrl(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}
