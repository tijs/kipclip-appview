import "../runtime/deno/install.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { assertIsolated } from "./migration/isolation.ts";

assertIsolated();

async function copySourceTree(source: URL, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const src = new URL(entry.name + (entry.isDirectory ? "/" : ""), source);
    const dest = `${destination}/${entry.name}`;
    if (entry.isDirectory) await copySourceTree(src, dest);
    else if (entry.isFile) await Deno.copyFile(src, dest);
    else throw new Error(`Unexpected source symlink ${src}`);
  }
}

Deno.test("migration actual frontend build is offline/deterministic and hashes final bytes for SRI", async () => {
  // macOS TMPDIR may use /var -> /private/var; permission grants must use
  // the same canonical path that the subprocess uses as its working directory.
  const root = await Deno.realPath(
    await Deno.makeTempDir({
      dir: Deno.env.get("TMPDIR"),
      prefix: "kipclip-build-contract-",
    }),
  );
  try {
    await copySourceTree(
      new URL("../frontend/", import.meta.url),
      `${root}/frontend`,
    );
    await copySourceTree(
      new URL("../shared/", import.meta.url),
      `${root}/shared`,
    );
    await Deno.mkdir(`${root}/lib`);
    await Deno.copyFile(
      new URL("../lib/atprotofans.ts", import.meta.url),
      `${root}/lib/atprotofans.ts`,
    );
    await Deno.mkdir(`${root}/static`);
    await Deno.writeTextFile(
      `${root}/static/bundle.00000000.js`,
      "obsolete fixture",
    );
    const build = async () => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--cached-only",
          "--deny-net",
          "--allow-read",
          `--allow-write=${root}`,
          "--allow-run",
          "--allow-env",
          "--config",
          fromFileUrl(new URL("../deno.json", import.meta.url)),
          fromFileUrl(new URL("../scripts/build-frontend.ts", import.meta.url)),
        ],
        cwd: root,
        clearEnv: true,
        env: {
          // Isolated, deterministic temp dir for the child: GitHub runners
          // set no parent TMPDIR, and Deno.Command env values must be
          // strings (undefined fails the spawn with a serde_v8 error).
          // `root` is also the only path the subprocess may write to.
          TMPDIR: root,
          KIPCLIP_VERSION: "v-migration-fixture",
          KIPCLIP_SHA: "fixture-sha",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const output = new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);
      assertEquals(result.code, 0, output);
      assert(!output.includes("Download "), output);
      return JSON.parse(
        await Deno.readTextFile(`${root}/static/manifest.json`),
      );
    };
    const manifest = await build();
    assertEquals(manifest.version, "v-migration-fixture");
    assertEquals(manifest.sha, "fixture-sha");
    assert(/^bundle\.[a-f0-9]{8}\.js$/.test(manifest["bundle.js"]));
    const bytes = await Deno.readFile(
      `${root}/static/${manifest["bundle.js"]}`,
    );
    const finalHash = new Uint8Array(
      await crypto.subtle.digest("SHA-384", bytes),
    );
    assertEquals(
      manifest.integrity,
      `sha384-${btoa(String.fromCharCode(...finalHash))}`,
    );
    const text = new TextDecoder().decode(bytes);
    assertStringIncludes(
      text,
      `//# sourceMappingURL=${manifest["bundle.js"]}.map`,
    );
    // Filename hash is calculated before the source-map URL rewrite. Preserve
    // that distinction while checking the SRI against the FINAL served bytes.
    const original = text.replace(
      `//# sourceMappingURL=${manifest["bundle.js"]}.map`,
      "//# sourceMappingURL=bundle.js.map",
    );
    const preHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original)),
    );
    const hex = [...preHash].map((byte) => byte.toString(16).padStart(2, "0"))
      .join("").slice(0, 8);
    assertEquals(manifest["bundle.js"], `bundle.${hex}.js`);
    const second = await build();
    assertEquals(second["bundle.js"], manifest["bundle.js"]);
    assertEquals(second.integrity, manifest.integrity);
    assertEquals(
      await Deno.readFile(`${root}/static/${manifest["bundle.js"]}`),
      bytes,
    );
    const names: string[] = [];
    for await (const entry of Deno.readDir(`${root}/static`)) {
      names.push(entry.name);
    }
    assertEquals(
      names.sort(),
      [manifest["bundle.js"], `${manifest["bundle.js"]}.map`, "manifest.json"]
        .sort(),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
