/**
 * File server utilities for serving static files.
 * Frontend is now pre-built, so no runtime transpilation needed.
 * Includes cache headers for optimal performance.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { contentType } from "@std/media-types";

/** Cache durations in seconds */
const CACHE_IMMUTABLE = 31536000; // 1 year
const CACHE_MEDIUM = 3600; // 1 hour
const CACHE_SHORT = 60; // 1 minute

/**
 * Determine cache control header based on file path.
 * Content-hashed files get immutable caching, others get shorter TTLs.
 */
function getCacheControl(path: string): string {
  const filename = path.split("/").pop() || "";

  // Content-hashed bundle files (bundle.xxxxxxxx.js) - immutable
  if (/^bundle\.[a-f0-9]{8}\.js(\.map)?$/.test(filename)) {
    return `public, max-age=${CACHE_IMMUTABLE}, immutable`;
  }

  // Other JS/CSS files - medium cache with revalidation
  if (filename.endsWith(".js") || filename.endsWith(".css")) {
    return `public, max-age=${CACHE_MEDIUM}`;
  }

  // HTML files - short cache, must revalidate
  if (filename.endsWith(".html")) {
    return `public, max-age=${CACHE_SHORT}, must-revalidate`;
  }

  // Default for other static assets
  return `public, max-age=${CACHE_MEDIUM}`;
}

/**
 * Resolve a path relative to the project root.
 * Works on both local development (file://) and Deno Deploy (app://).
 */
function resolveProjectPath(path: string, baseUrl: string): string {
  // Remove leading slash from path
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;

  // Get the directory of the base URL (main.ts location)
  const baseUrlObj = new URL(baseUrl);

  if (baseUrlObj.protocol === "file:") {
    // Local development - resolve from filesystem
    const baseDir = dirname(fromFileUrl(baseUrl));
    return join(baseDir, cleanPath);
  } else {
    // Deno Deploy (app://) - resolve relative to base
    // import.meta.url is like "app:///main.ts", so dirname gives "app:///"
    const basePath = dirname(baseUrlObj.pathname);
    return join(basePath, cleanPath);
  }
}

/**
 * Read a file from the project relative to the given base URL.
 *
 * @param path - Path to file (e.g., "/frontend/index.html")
 * @param baseUrl - import.meta.url of the calling module
 * @returns File contents as string
 */
export async function readFile(path: string, baseUrl: string): Promise<string> {
  const filePath = resolveProjectPath(path, baseUrl);

  try {
    const content = await Deno.readTextFile(filePath);
    return content;
  } catch (error) {
    console.error(`Failed to read file: ${filePath}`, error);
    throw error;
  }
}

/**
 * Serve a file from the project with appropriate content-type and cache headers.
 *
 * @param path - Path to file (e.g., "/frontend/style.css")
 * @param baseUrl - import.meta.url of the calling module
 * @returns Response with file contents and caching headers
 */
export async function serveFile(
  path: string,
  baseUrl: string,
): Promise<Response> {
  try {
    const ext = path.split(".").pop() || "";
    const content = await readFile(path, baseUrl);
    const mimeType = contentType(ext) || "application/octet-stream";
    const cacheControl = getCacheControl(path);

    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
        "Cache-Control": cacheControl,
      },
    });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}

/**
 * Read and parse the bundle manifest to get the current hashed bundle filename.
 *
 * @param baseUrl - import.meta.url of the calling module
 * @returns The current bundle filename (e.g., "bundle.abc12345.js")
 */
export async function getBundleFileName(baseUrl: string): Promise<string> {
  try {
    const manifestContent = await readFile("/static/manifest.json", baseUrl);
    const manifest = JSON.parse(manifestContent);
    return manifest["bundle.js"] || "bundle.js";
  } catch {
    // Fallback if manifest doesn't exist (development)
    return "bundle.js";
  }
}
