import type { UrlMetadata } from "../../shared/types.ts";

/**
 * Extracts metadata from a URL by fetching and parsing the HTML
 */
export async function extractUrlMetadata(
  url: string,
): Promise<UrlMetadata> {
  try {
    // Validate URL
    const parsedUrl = new URL(url);
    if (!parsedUrl.protocol.startsWith("http")) {
      throw new Error("Only HTTP(S) URLs are supported");
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
      // For non-HTML content, just return the URL as title
      return {
        title: parsedUrl.hostname,
      };
    }

    // Parse HTML
    const html = await response.text();
    return parseHtmlMetadata(html, parsedUrl);
  } catch (error) {
    console.error(`Failed to extract metadata from ${url}:`, error);
    // Return minimal metadata on error
    const parsedUrl = new URL(url);
    return {
      title: parsedUrl.hostname,
    };
  }
}

/**
 * Parses HTML to extract metadata
 */
function parseHtmlMetadata(html: string, url: URL): UrlMetadata {
  const metadata: UrlMetadata = {};

  // Extract title - try <title> tag first
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    metadata.title = decodeHtmlEntities(titleMatch[1].trim());
  }

  // Try og:title as fallback
  if (!metadata.title) {
    const ogTitleMatch = html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    );
    if (ogTitleMatch) {
      metadata.title = decodeHtmlEntities(ogTitleMatch[1].trim());
    }
  }

  // Extract description from meta tags
  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );
  if (descMatch) {
    metadata.description = decodeHtmlEntities(descMatch[1].trim());
  }

  // Try og:description as fallback
  if (!metadata.description) {
    const ogDescMatch = html.match(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    );
    if (ogDescMatch) {
      metadata.description = decodeHtmlEntities(ogDescMatch[1].trim());
    }
  }

  // Extract favicon
  const faviconMatch = html.match(
    /<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/i,
  );
  if (faviconMatch) {
    const faviconUrl = faviconMatch[1];
    // Resolve relative URLs
    metadata.favicon = new URL(faviconUrl, url).href;
  }

  // Default to hostname/favicon.ico if no favicon found
  if (!metadata.favicon) {
    metadata.favicon = new URL("/favicon.ico", url.origin).href;
  }

  // Use hostname as fallback title
  if (!metadata.title) {
    metadata.title = url.hostname;
  }

  return metadata;
}

/**
 * Decode common HTML entities
 */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };

  return text.replace(/&[^;]+;/g, (entity) => entities[entity] || entity);
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
