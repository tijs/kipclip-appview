/**
 * Dependency-audit gate with a scoped allowlist.
 *
 * Wraps `deno audit`. Any advisory that is NOT explicitly allowlisted below
 * fails the build, exactly like a bare `deno audit`. The allowlist exists
 * because `deno audit` (2.8.0) has no per-advisory ignore for advisories that
 * carry only a GHSA id and no CVE — `--ignore` matches CVE ids only.
 *
 * KEEP THIS LIST TINY. Each entry must name a specific advisory, say why it
 * cannot be fixed from our side, and what would let us drop it again.
 */
const ALLOWLIST: Record<string, string> = {};

// deno audit colorizes output; strip ANSI before parsing.
// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

const cmd = new Deno.Command(Deno.execPath(), {
  args: ["audit"],
  stdout: "piped",
  stderr: "piped",
});
const { code, stdout, stderr } = await cmd.output();
const raw = new TextDecoder().decode(stdout) +
  new TextDecoder().decode(stderr);
const out = raw.replace(ANSI, "");

// Clean audit — nothing to do.
if (code === 0) {
  console.log(out.trim() || "✅ Audit: no vulnerabilities.");
  Deno.exit(0);
}

// Pull every advisory id out of the "Info: .../advisories/<ID>" lines.
const ids = [...out.matchAll(/advisories\/([A-Za-z0-9-]+)/g)].map((m) => m[1]);

// Non-zero exit but no advisories parsed => registry error, a new output
// format, or some other failure we must not silently pass.
if (ids.length === 0) {
  console.error(out.trim());
  console.error(
    "\n❌ Audit failed and no advisories could be parsed — failing closed.",
  );
  Deno.exit(1);
}

const blocking = ids.filter((id) => !(id in ALLOWLIST));

if (blocking.length > 0) {
  console.error(out.trim());
  console.error(
    `\n❌ Audit: ${blocking.length} non-allowlisted advisory(ies): ${
      [...new Set(blocking)].join(", ")
    }`,
  );
  Deno.exit(1);
}

const accepted = [...new Set(ids)];
console.log(out.trim());
console.log(
  `\n✅ Audit: ${accepted.length} advisory(ies) present, all allowlisted:`,
);
for (const id of accepted) console.log(`   • ${id} — ${ALLOWLIST[id]}`);
Deno.exit(0);
