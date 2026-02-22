import type { UrlMetadata } from "../shared/types.ts";
import { decode } from "html-entities";

/** Maximum lengths for metadata fields */
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_IMAGE_URL_LENGTH = 2000;

/**
 * Check if a hostname points to a private/internal IP range.
 * Blocks: localhost, private ranges, link-local, cloud metadata endpoints.
 */
function isPrivateUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();

  // Block localhost variants
  if (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  ) {
    return true;
  }

  // Block cloud metadata endpoints
  if (
    hostname === "169.254.169.254" || hostname === "metadata.google.internal"
  ) {
    return true;
  }

  // Check common private IP patterns in hostname
  const privatePatterns = [
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^127\./, // 127.0.0.0/8
    /^169\.254\./, // Link-local
    /^0\./, // 0.0.0.0/8
    /^fd[0-9a-f]{2}:/i, // IPv6 ULA
    /^fe80:/i, // IPv6 link-local
  ];

  return privatePatterns.some((pattern) => pattern.test(hostname));
}

/**
 * Sanitize extracted text content.
 * - Trim whitespace
 * - Limit length
 * - Remove control characters
 * - Collapse multiple spaces
 */
function sanitizeText(text: string, maxLength: number): string {
  // deno-lint-ignore no-control-regex
  const controlCharsRegex = /[\x00-\x1F\x7F]/g;
  return text
    .trim()
    .replace(controlCharsRegex, "") // Remove control characters
    .replace(/\s+/g, " ") // Collapse whitespace
    .slice(0, maxLength);
}

/**
 * Validate and sanitize a URL (for favicon, image, etc).
 * Only allow http/https URLs, block javascript:, data:, etc.
 */
function sanitizeUrl(
  urlString: string,
  baseUrl: URL,
  maxLength: number = MAX_IMAGE_URL_LENGTH,
): string | undefined {
  try {
    const resolved = new URL(urlString, baseUrl);
    // Only allow http/https protocols
    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      const href = resolved.href;
      return href.length <= maxLength ? href : undefined;
    }
  } catch {
    // Invalid URL
  }
  return undefined;
}

/**
 * Validate favicon URL.
 * Only allow http/https URLs, block javascript:, data:, etc.
 */
function sanitizeFaviconUrl(
  faviconUrl: string,
  baseUrl: URL,
): string | undefined {
  return sanitizeUrl(faviconUrl, baseUrl);
}

/** Default favicon URL for a given origin (e.g. https://example.com/favicon.ico). */
function defaultFavicon(url: URL): string {
  return new URL("/favicon.ico", url.origin).href;
}

/**
 * Extracts metadata from a URL by fetching and parsing the HTML.
 */
export function extractUrlMetadata(url: string): Promise<UrlMetadata> {
  return fetchUrlMetadata(url);
}

/**
 * Actually fetch and parse URL metadata (called by cache on miss).
 */
async function fetchUrlMetadata(url: string): Promise<UrlMetadata> {
  try {
    // Validate URL
    const parsedUrl = new URL(url);
    if (!parsedUrl.protocol.startsWith("http")) {
      throw new Error("Only HTTP(S) URLs are supported");
    }

    // SSRF protection: block private/internal URLs
    if (isPrivateUrl(parsedUrl)) {
      console.warn(`[Enrichment] Blocked private URL: ${parsedUrl.hostname}`);
      return { title: parsedUrl.hostname, favicon: defaultFavicon(parsedUrl) };
    }

    // Fetch the URL with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "kipclip-bot/1.0 (Bookmark enrichment; +https://kipclip.com)",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Only process HTML content
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return {
        title: parsedUrl.hostname,
        favicon: defaultFavicon(parsedUrl),
      };
    }

    // Parse HTML
    const html = await response.text();
    return parseHtmlMetadata(html, parsedUrl);
  } catch (error) {
    console.error(`Failed to extract metadata from ${url}:`, error);
    try {
      const parsedUrl = new URL(url);
      return { title: parsedUrl.hostname, favicon: defaultFavicon(parsedUrl) };
    } catch {
      return { title: url };
    }
  }
}

/**
 * Parses HTML to extract metadata with sanitization.
 */
function parseHtmlMetadata(html: string, url: URL): UrlMetadata {
  const metadata: UrlMetadata = {};

  // Extract title - try <title> tag first
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    metadata.title = sanitizeText(decode(titleMatch[1]), MAX_TITLE_LENGTH);
  }

  // Try og:title as fallback (handle both attribute orderings)
  if (!metadata.title) {
    const ogTitleMatch = html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    ) || html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    );
    if (ogTitleMatch) {
      metadata.title = sanitizeText(decode(ogTitleMatch[1]), MAX_TITLE_LENGTH);
    }
  }

  // Extract description from meta tags (handle both attribute orderings)
  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
  );
  if (descMatch) {
    metadata.description = sanitizeText(
      decode(descMatch[1]),
      MAX_DESCRIPTION_LENGTH,
    );
  }

  // Try og:description as fallback (handle both attribute orderings)
  if (!metadata.description) {
    const ogDescMatch = html.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    ) || html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
    );
    if (ogDescMatch) {
      metadata.description = sanitizeText(
        decode(ogDescMatch[1]),
        MAX_DESCRIPTION_LENGTH,
      );
    }
  }

  // Extract and validate favicon URL
  // Non-greedy [^>]+? to match the first href= (not data-base-href= etc.)
  const faviconMatch = html.match(
    /<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+?href=["']([^"']+)["']/i,
  );
  if (faviconMatch) {
    metadata.favicon = sanitizeFaviconUrl(faviconMatch[1], url);
  }

  // Default to hostname/favicon.ico if no valid favicon found
  if (!metadata.favicon) {
    metadata.favicon = defaultFavicon(url);
  }

  // Extract preview image - try og:image first
  // Handle both attribute orderings: property before content, or content before property
  const ogImageMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  ) || html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  );
  if (ogImageMatch) {
    metadata.image = sanitizeUrl(ogImageMatch[1], url);
  }

  // Try twitter:image as fallback
  if (!metadata.image) {
    const twitterImageMatch = html.match(
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ) || html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    );
    if (twitterImageMatch) {
      metadata.image = sanitizeUrl(twitterImageMatch[1], url);
    }
  }

  // Use hostname as fallback title
  if (!metadata.title) {
    metadata.title = url.hostname;
  }

  return metadata;
}

/**
 * Testable function for dependency injection
 */
export async function extractUrlMetadataWithFetcher(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<UrlMetadata> {
  // This version accepts a custom fetcher for testing
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await extractUrlMetadata(url);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
