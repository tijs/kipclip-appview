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
 * Resolve the running release version. The release script (deploy/release/
 * update.sh) sets KIPCLIP_VERSION when it builds in a release dir; local dev
 * usually runs without it set, so fall back to the latest semver tag, then to
 * "dev" when no tags or no git are reachable. Failures are non-fatal — the
 * frontend Footer renders without a tag if the manifest carries "dev" or
 * "unknown".
 */
async function resolveVersion(): Promise<string> {
  const fromEnv = Deno.env.get("KIPCLIP_VERSION");
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const cmd = new Deno.Command("git", {
      args: ["describe", "--tags", "--abbrev=0", "--match", "v*"],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const tag = new TextDecoder().decode(stdout).trim();
      if (tag.length > 0) return tag;
    }
  } catch { /* git not available */ }
  return "dev";
}

async function resolveSha(): Promise<string> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const sha = new TextDecoder().decode(stdout).trim();
      if (sha.length > 0) return sha;
    }
  } catch { /* git not available */ }
  return "unknown";
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
      "sonner":
        "https://esm.sh/sonner@2?alias=react:https://esm.sh/react@19,react-dom:https://esm.sh/react-dom@19",
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

  // Write bundle with hashed filename, fixing sourceMappingURL to match
  let bundleText = new TextDecoder().decode(bundleOutput.contents);
  bundleText = bundleText.replace(
    /\/\/# sourceMappingURL=bundle\.js\.map/,
    `//# sourceMappingURL=${bundleFileName}.map`,
  );
  await Deno.writeTextFile(bundlePath, bundleText);

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

  // Write manifest.json for runtime bundle lookup. Version + sha + builtAt
  // are exposed via /api/version (routes/api/system.ts) so the running
  // release is observable from the browser, monitoring, and Sentry.
  const builtAt = new Date().toISOString();
  const [version, sha] = await Promise.all([resolveVersion(), resolveSha()]);
  const manifest = {
    "bundle.js": bundleFileName,
    buildTime: builtAt,
    version,
    sha,
    builtAt,
  };
  await Deno.writeTextFile("static/manifest.json", JSON.stringify(manifest));

  // Clean up old bundles
  await cleanOldBundles(bundleFileName);

  const elapsed = Date.now() - startTime;
  const outputSizeKB = (bundleOutput.contents.length / 1024).toFixed(1);

  console.log(`✅ Frontend bundle built in ${elapsed}ms`);
  console.log(`   Output: ${bundlePath} (${outputSizeKB} KB)`);
  console.log(`   Hash: ${contentHash}`);
  console.log(`   Version: ${version} (sha ${sha})`);
} catch (error) {
  console.error("❌ Build failed:", error);
  Deno.exit(1);
} finally {
  esbuild.stop();
}
