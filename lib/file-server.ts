/**
 * Universal file server utilities with TypeScript/TSX transpilation.
 * Uses esbuild to transpile on-the-fly for local development and Deno Deploy.
 */

import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { contentType } from "jsr:@std/media-types@1";
import * as esbuild from "https://esm.sh/esbuild-wasm@0.24.0";

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
 * Serve a file from the project with appropriate content-type headers.
 *
 * For TypeScript/TSX files, transpiles them to JavaScript using esbuild.
 * This allows the frontend to work locally just like on Val.Town.
 *
 * @param path - Path to file (e.g., "/frontend/style.css")
 * @param baseUrl - import.meta.url of the calling module
 * @returns Response with file contents
 */
export async function serveFile(
  path: string,
  baseUrl: string,
): Promise<Response> {
  try {
    const ext = path.split(".").pop() || "";

    // For TypeScript/TSX/JSX files, transpile to JavaScript using esbuild
    if (ext === "tsx" || ext === "ts" || ext === "jsx") {
      const filePath = resolveProjectPath(path, baseUrl);

      try {
        const result = await esbuild.build({
          entryPoints: [filePath],
          bundle: false,
          format: "esm",
          jsx: "automatic",
          jsxImportSource: "https://esm.sh/react",
          write: false,
          loader: {
            ".ts": "ts",
            ".tsx": "tsx",
            ".jsx": "jsx",
          },
        });

        const jsCode = result.outputFiles[0].text;

        return new Response(jsCode, {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
          },
        });
      } catch (buildError) {
        console.error(`Failed to transpile ${path}:`, buildError);
        return new Response(`Error transpiling ${path}`, { status: 500 });
      }
    }

    // For other files, serve as-is
    const content = await readFile(path, baseUrl);
    const mimeType = contentType(ext) || "application/octet-stream";

    return new Response(content, {
      headers: {
        "Content-Type": mimeType,
      },
    });
  } catch {
    return new Response("File not found", { status: 404 });
  }
}
