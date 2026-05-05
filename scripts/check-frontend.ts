#!/usr/bin/env -S deno run -A
/**
 * Targeted frontend type-check.
 *
 * Runs `deno check` against the esbuild entrypoint and fails only on the
 * error classes that actually break runtime:
 *
 *   TS2304  Cannot find name 'X' — missing component/value import
 *           (the EditTag <Button> bug → blank screen in production).
 *   TS2307  Cannot find module 'X' — missing module import.
 *
 * Pre-existing noise we tolerate (the bundle still works because esbuild
 * resolves these at build time):
 *
 *   TS2875  npm:react@19/jsx-runtime not resolvable — Deno/npm interop
 *           limitation; esbuild handles JSX.
 *   TS2503  Cannot find namespace 'React' — type-only, runtime fine.
 *   TS2322  Property 'key' does not exist — React reserved prop.
 *
 * Once those are cleaned up the whole `deno check` exit code can become
 * the gate; until then this script catches the catastrophic class.
 */

const ENTRYPOINT = "frontend/index.tsx";
const FATAL_CODES = ["TS2304", "TS2307"];

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
  if (!FATAL_CODES.includes(codeMatch[0])) continue;

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
    `❌ Frontend check failed: ${fatalBlocks.length} fatal error(s) ` +
      `(${FATAL_CODES.join(", ")})\n`,
  );
  for (const block of fatalBlocks) {
    console.error(block);
    console.error("");
  }
  console.error(
    "These are the same class of bug as the EditTag <Button> blank-screen " +
      "regression. Add the missing import or fix the typo before pushing.",
  );
  Deno.exit(1);
}

console.log(
  `✅ Frontend check: no fatal errors (${FATAL_CODES.join(", ")} clean).`,
);
