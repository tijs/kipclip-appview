/** Shared application implementations may only use declared host capabilities. */
import { join } from "@std/path";
const roots = ["main.ts", "lib", "routes", "worker", "mirror", "shared"];
const errors: string[] = [];
async function check(path: string) {
  const stat = await Deno.stat(path);
  if (stat.isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isDirectory || entry.name.endsWith(".ts")) {
        await check(join(path, entry.name));
      }
    }
    return;
  }
  const text = await Deno.readTextFile(path);
  // Comments mention prior implementation/runtime context, not executable calls.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /^\s*\/\/.*$/gm,
    "",
  );
  if (
    /\b(?:Deno|Bun)\s*\./.test(code) ||
    /(?:from\s*|import\s*\(?\s*)["']node:/.test(code)
  ) errors.push(path);
}
for (const root of roots) await check(root);
if (errors.length) {
  console.error(
    "Native runtime access in shared implementation: " + errors.join(", "),
  );
  Deno.exit(1);
}
console.log("Shared runtime audit: zero direct native globals/imports");
