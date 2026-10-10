/** Deterministic removed-framework reference audit; no network or git writes. */
import { fromFileUrl, join } from "@std/path";

export async function auditFrameworkReferences(
  root: string,
): Promise<string[]> {
  const name = ["fr", "esh"].join("");
  const brand = name[0].toUpperCase() + name.slice(1);
  const blocked = new RegExp(
    "@" + name + "/|\\b" + name + "/(?:dev|internal)|_" + name + "\\b|\\b" +
      brand + "\\b",
  );
  const extensions =
    /\.(?:ts|tsx|js|mjs|json|lock|md|yml|yaml|toml|sh|service|timer|rules|html|css)$/;
  const errors: string[] = [];
  async function walk(directory: string, prefix = "") {
    const entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if ([".git", "node_modules", ".local", "coverage"].includes(entry.name)) {
        continue;
      }
      if (entry.name.startsWith(".env")) continue; // Never inspect credentials.
      const path = join(directory, entry.name);
      if (entry.isDirectory) {
        if (entry.name === "_" + name) {
          errors.push(relative + ": obsolete generated directory");
        } else await walk(path, relative + "/");
      } else if (
        entry.isFile &&
        (extensions.test(entry.name) ||
          [".gitignore", "Dockerfile"].includes(entry.name))
      ) {
        const text = await Deno.readTextFile(path);
        let historical = false;
        text.split("\n").forEach((line, index) => {
          if (relative === "CHANGELOG.md" && /^## \[/.test(line)) {
            historical = !/^## \[Unreleased\]/i.test(line);
          }
          if (relative === "CHANGELOG.md" && historical) return;
          if (blocked.test(line)) {
            errors.push(
              `${relative}:${index + 1}: obsolete framework reference`,
            );
          }
        });
      }
    }
  }
  await walk(root);
  return errors;
}

if (import.meta.main) {
  const errors = await auditFrameworkReferences(
    Deno.args[0] ?? fromFileUrl(new URL("../", import.meta.url)),
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    Deno.exit(1);
  }
  console.log(
    "Framework reference audit: zero obsolete dependencies/imports/generated references",
  );
}
