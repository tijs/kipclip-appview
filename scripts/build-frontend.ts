/**
 * Build script for the frontend bundle.
 * Uses esbuild to bundle all frontend TypeScript/TSX into a single JavaScript file.
 */

import * as esbuild from "esbuild";

const startTime = Date.now();

try {
  const result = await esbuild.build({
    entryPoints: ["frontend/index.tsx"],
    bundle: true,
    format: "esm",
    outfile: "static/bundle.js",
    jsx: "automatic",
    jsxImportSource: "https://esm.sh/react@19",
    minify: true,
    sourcemap: true,
    target: ["es2020"],
    // Log build info
    metafile: true,
  });

  const elapsed = Date.now() - startTime;
  const outputSize = result.metafile?.outputs["static/bundle.js"]?.bytes ?? 0;
  const outputSizeKB = (outputSize / 1024).toFixed(1);

  console.log(`✅ Frontend bundle built in ${elapsed}ms`);
  console.log(`   Output: static/bundle.js (${outputSizeKB} KB)`);
} catch (error) {
  console.error("❌ Build failed:", error);
  Deno.exit(1);
} finally {
  esbuild.stop();
}
