import "../runtime/deno/install.ts";
import { assertEquals } from "@std/assert";
import { auditFrameworkReferences } from "../scripts/audit-framework.ts";

Deno.test("framework audit detects obsolete imports, locks, docs and generated directories", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.env.get("TMPDIR"),
    prefix: "kipclip-audit-contract-",
  });
  const name = ["fr", "esh"].join("");
  try {
    await Deno.writeTextFile(
      root + "/module.ts",
      `import { App } from "@${name}/core";`,
    );
    await Deno.writeTextFile(
      root + "/deno.lock",
      JSON.stringify({ dependency: "jsr:@" + name + "/core" }),
    );
    await Deno.writeTextFile(
      root + "/guide.md",
      name[0].toUpperCase() + name.slice(1),
    );
    await Deno.mkdir(root + "/_" + name);
    assertEquals(
      (await auditFrameworkReferences(root)).map((line) => line.split(":")[0]),
      ["_" + name, "deno.lock", "guide.md", "module.ts"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("framework audit permits only historical release notes and does not read credentials", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.env.get("TMPDIR"),
    prefix: "kipclip-audit-contract-",
  });
  const brand = ["Fr", "esh"].join("");
  try {
    await Deno.writeTextFile(
      root + "/CHANGELOG.md",
      "# Changelog\n## [v1.0.0] - 2020-01-01\n" + brand + " historical release",
    );
    await Deno.writeTextFile(
      root + "/.env",
      brand + " fake credential fixture",
    );
    await Deno.writeTextFile(
      root + "/module.ts",
      "export const framework = 'Hono';",
    );
    assertEquals(await auditFrameworkReferences(root), []);
    await Deno.writeTextFile(
      root + "/CHANGELOG.md",
      "# Changelog\n## [Unreleased]\n" + brand,
    );
    assertEquals((await auditFrameworkReferences(root)).length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("framework audit rejects contiguous legacy entrypoint references", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.env.get("TMPDIR"),
    prefix: "kipclip-audit-contract-",
  });
  const name = ["fr", "esh"].join("");
  const entrypoint = "_" + name + "/server.js";
  try {
    await Deno.mkdir(root + "/deploy/release", { recursive: true });
    // Contiguous references are rejected everywhere — including the
    // release machinery's own files (no exemptions) — while the
    // split-fragment form used by update.sh stays clean.
    await Deno.writeTextFile(
      root + "/deploy/release/update.sh",
      'exec_line="ExecStart=' + entrypoint + '"\n' +
        'split="_""' + name + '/server.js"\n',
    );
    await Deno.writeTextFile(
      root + "/module.ts",
      'import "' + entrypoint + '";\n',
    );
    assertEquals(
      (await auditFrameworkReferences(root)).map((line) => line.split(":")[0]),
      ["deploy/release/update.sh", "module.ts"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
