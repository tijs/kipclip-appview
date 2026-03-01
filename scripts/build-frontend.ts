/**
 * Build script for the frontend bundle.
 * Uses esbuild to bundle all frontend TypeScript/TSX into a single JavaScript file.
 * Generates content-hashed filenames for optimal caching.
 */

import * as esbuild from "esbuild";
import { encodeHex } from "@std/encoding/hex";

const startTime = Date.now();

/**
 * Generate a short hash from content for cache busting.
 */
async function generateContentHash(content: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", content);
  const hashArray = new Uint8Array(hashBuffer);
  return encodeHex(hashArray).slice(0, 8);
}

/**
 * Clean up old bundle files, keeping only the current one.
 */
async function cleanOldBundles(currentBundleName: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir("static")) {
      if (
        entry.isFile &&
        entry.name.startsWith("bundle.") &&
        entry.name.endsWith(".js") &&
        entry.name !== currentBundleName &&
        entry.name !== `${currentBundleName}.map`
      ) {
        await Deno.remove(`static/${entry.name}`);
        console.log(`   Cleaned: ${entry.name}`);
      }
      // Also clean old sourcemaps
      if (
        entry.isFile &&
        entry.name.startsWith("bundle.") &&
        entry.name.endsWith(".js.map") &&
        entry.name !== `${currentBundleName}.map`
      ) {
        await Deno.remove(`static/${entry.name}`);
        console.log(`   Cleaned: ${entry.name}`);
      }
    }
  } catch (error) {
    // Directory might not exist on first build
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn("Warning: Could not clean old bundles:", error);
    }
  }
}

try {
  // Build to memory first to get the content for hashing
  const result = await esbuild.build({
    entryPoints: ["frontend/index.tsx"],
    bundle: true,
    format: "esm",
    outfile: "bundle.js", // Required for outputFiles to work
    write: false, // Don't write, we need to hash first
    jsx: "automatic",
    jsxImportSource: "https://esm.sh/react@19",
    minify: true,
    sourcemap: true,
    target: ["es2020"],
    alias: {
      "react": "https://esm.sh/react@19",
      "react-dom/client": "https://esm.sh/react-dom@19/client",
      "@tanstack/react-virtual": "https://esm.sh/@tanstack/react-virtual@3",
      "idb": "https://esm.sh/idb@8",
    },
    metafile: true,
  });

  // Find the main bundle output (ends with .js but not .js.map)
  const bundleOutput = result.outputFiles?.find(
    (f) => f.path.endsWith(".js") && !f.path.endsWith(".js.map"),
  );
  const sourcemapOutput = result.outputFiles?.find((f) =>
    f.path.endsWith(".js.map")
  );

  if (!bundleOutput) {
    console.error("Output files:", result.outputFiles?.map((f) => f.path));
    throw new Error("No bundle output found");
  }

  // Generate content hash
  const contentHash = await generateContentHash(bundleOutput.contents);
  const bundleFileName = `bundle.${contentHash}.js`;
  const bundlePath = `static/${bundleFileName}`;

  // Ensure static directory exists
  await Deno.mkdir("static", { recursive: true });

  // Write bundle with hashed filename
  await Deno.writeFile(bundlePath, bundleOutput.contents);

  // Write sourcemap if present
  if (sourcemapOutput) {
    // Update sourcemap to reference the hashed bundle name
    const sourcemapContent = new TextDecoder().decode(sourcemapOutput.contents);
    const updatedSourcemap = sourcemapContent.replace(
      /"file":\s*"[^"]*"/,
      `"file": "${bundleFileName}"`,
    );
    await Deno.writeTextFile(`${bundlePath}.map`, updatedSourcemap);
  }

  // Write manifest.json for runtime bundle lookup
  const manifest = {
    "bundle.js": bundleFileName,
    buildTime: new Date().toISOString(),
  };
  await Deno.writeTextFile("static/manifest.json", JSON.stringify(manifest));

  // Clean up old bundles
  await cleanOldBundles(bundleFileName);

  const elapsed = Date.now() - startTime;
  const outputSizeKB = (bundleOutput.contents.length / 1024).toFixed(1);

  console.log(`✅ Frontend bundle built in ${elapsed}ms`);
  console.log(`   Output: ${bundlePath} (${outputSizeKB} KB)`);
  console.log(`   Hash: ${contentHash}`);
} catch (error) {
  console.error("❌ Build failed:", error);
  Deno.exit(1);
} finally {
  esbuild.stop();
}
