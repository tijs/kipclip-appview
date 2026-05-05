#!/usr/bin/env -S deno run -A
/**
 * Frontend type-check.
 *
 * Runs `deno check` against the esbuild entrypoint and fails on every
 * TypeScript error class except TS2875 (`npm:react@19/jsx-runtime` not
 * resolvable). TS2875 is a Deno/npm interop quirk — esbuild handles JSX
 * at build time so runtime is unaffected. Adding `@types/react` to the
 * import map would silence it but isn't worth the dependency churn until
 * phase 4 frontend rework.
 *
 * Everything else is fatal, including the EditTag-class regression
 * (TS2304 Cannot find name → blank screen in production).
 */

const ENTRYPOINT = "frontend/index.tsx";
const IGNORED_CODES = new Set(["TS2875"]);

const cmd = new Deno.Command("deno", {
  args: ["check", "--allow-import", ENTRYPOINT],
  stdout: "piped",
  stderr: "piped",
});
const { stderr } = await cmd.output();
const text = new TextDecoder().decode(stderr);

const lines = text.split("\n");
const fatalBlocks: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const codeMatch = lines[i].match(/TS\d+/);
  if (!codeMatch) continue;
  if (IGNORED_CODES.has(codeMatch[0])) continue;

  // Capture the error line and a few following lines for context (file:line:col).
  const block = [lines[i]];
  for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
    if (lines[j].match(/TS\d+/)) break;
    block.push(lines[j]);
  }
  fatalBlocks.push(block.join("\n"));
}

if (fatalBlocks.length > 0) {
  console.error(
    `❌ Frontend check failed: ${fatalBlocks.length} error(s) ` +
      `(ignoring: ${[...IGNORED_CODES].join(", ")})\n`,
  );
  for (const block of fatalBlocks) {
    console.error(block);
    console.error("");
  }
  console.error(
    "Fix these before pushing — they're the same class of bug as the EditTag",
    "<Button> blank-screen regression.",
  );
  Deno.exit(1);
}

console.log(
  `✅ Frontend check: clean (only ${[...IGNORED_CODES].join(", ")} tolerated).`,
);
