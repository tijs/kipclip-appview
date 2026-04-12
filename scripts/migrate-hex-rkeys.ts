/**
 * One-time migration: convert hex-format rkeys to AT Protocol TIDs.
 *
 * Drives the migration by calling the kipclip API in small batches:
 *   1. POST /api/migrate-hex-rkeys/plan — get the full migration plan
 *   2. POST /api/migrate-hex-rkeys/batch — execute batches of 5
 *
 * Usage:
 *   SESSION_COOKIE="sid=xxx" deno run -A scripts/migrate-hex-rkeys.ts [--dry-run]
 */

const BASE_URL = Deno.env.get("BASE_URL") || "http://localhost:8000";
const DRY_RUN = Deno.args.includes("--dry-run");
const BATCH_SIZE = 5;

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN ===" : "=== LIVE MIGRATION ===");

  const cookie = Deno.env.get("SESSION_COOKIE");
  if (!cookie) {
    console.error(
      "\nSet SESSION_COOKIE env var to your kipclip session cookie.",
    );
    console.error(
      '\nExample: SESSION_COOKIE="sid=xxx" deno run -A scripts/migrate-hex-rkeys.ts',
    );
    Deno.exit(1);
  }

  // Step 1: Get migration plan
  console.log("Fetching migration plan...");
  const planRes = await fetch(`${BASE_URL}/api/migrate-hex-rkeys/plan`, {
    method: "POST",
    headers: { cookie },
  });

  if (!planRes.ok) {
    console.error(`Plan failed (${planRes.status}): ${await planRes.text()}`);
    Deno.exit(1);
  }

  const plan = await planRes.json();
  // Save the refreshed cookie for subsequent requests
  const newCookie = planRes.headers.get("set-cookie")?.split(";")[0] || cookie;

  console.log(`Total bookmarks: ${plan.total}`);
  console.log(`Hex rkeys to migrate: ${plan.hexCount}`);
  console.log(`TID rkeys (OK): ${plan.tidCount}\n`);

  if (plan.hexCount === 0) {
    console.log("Nothing to migrate!");
    return;
  }

  // Show samples
  console.log("Sample migrations:");
  for (const m of plan.plan.slice(0, 5)) {
    console.log(`  ${m.oldRkey} → ${m.newRkey} (${m.createdAt})`);
  }
  if (plan.plan.length > 5) {
    console.log(`  ... and ${plan.plan.length - 5} more`);
  }
  console.log();

  if (DRY_RUN) {
    console.log("Dry run complete. Run without --dry-run to execute.");
    return;
  }

  // Step 2: Execute in batches
  let migrated = 0;
  let failed = 0;
  const startTime = Date.now();
  let currentCookie = newCookie;

  for (let i = 0; i < plan.plan.length; i += BATCH_SIZE) {
    const batch = plan.plan.slice(i, i + BATCH_SIZE);

    const res = await fetch(`${BASE_URL}/api/migrate-hex-rkeys/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: currentCookie,
      },
      body: JSON.stringify({ items: batch }),
    });

    // Keep cookie fresh
    const refreshedCookie = res.headers.get("set-cookie")?.split(";")[0];
    if (refreshedCookie) currentCookie = refreshedCookie;

    if (res.status === 429) {
      const data = await res.json();
      const waitMs = data.retryAfter ? parseInt(data.retryAfter) * 1000 : 30000;
      console.log(`  Rate limited, waiting ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
      i -= BATCH_SIZE; // Retry
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      migrated += data.migrated;
    } else {
      const errorText = await res.text();
      console.error(`  Batch failed (${res.status}): ${errorText}`);
      failed += batch.length;
    }

    const total = migrated + failed;
    if (total % 50 === 0 || total === plan.plan.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `  Progress: ${total}/${plan.plan.length} (${migrated} OK, ${failed} failed) [${elapsed}s]`,
      );
    }

    // Small delay between batches
    if (i + BATCH_SIZE < plan.plan.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nMigration complete in ${elapsed}s`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) console.log("\nRe-run to retry failed records.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  Deno.exit(1);
});
