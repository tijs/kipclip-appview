import "../../runtime/deno/install.ts";
/** Isolated child-process probe: no .env, no network permissions, in-memory DB. */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { db } from "../../lib/db.ts";
import { getBaseUrl, getOAuth } from "../../lib/oauth-config.ts";
import { startPreviewEnrichmentWorker } from "../../lib/preview-enrichment-worker.ts";
import { assertIsolated } from "./isolation.ts";

assertIsolated();
const scenario = Deno.args[0];
const queries: string[] = [];
const events: string[] = [];
const logs: string[] = [];
const intervals: number[] = [];
const execute = db.execute;
const log = console.log;
console.log = (...args) => {
  logs.push(args.map(String).join(" "));
  if (String(args[0]).includes("All migrations completed successfully")) {
    events.push("migrations-complete");
  }
};
globalThis.fetch = () => {
  throw new Error("Startup must not fetch external endpoints");
};
globalThis.setInterval = ((_callback: () => void, delay: number) => {
  intervals.push(delay);
  return -intervals.length;
}) as typeof setInterval;
let seeded = false;
db.execute = async (query) => {
  queries.push(query.sql);
  if (query.sql.startsWith("DELETE FROM seen_webhook_deliveries")) {
    events.push("webhook-gc");
    if (scenario === "gc-failure") throw new Error("fixture GC failure");
  }
  const result = await execute(query);
  if (
    !seeded &&
    query.sql.includes("CREATE TABLE IF NOT EXISTS seen_webhook_deliveries")
  ) {
    seeded = true;
    await execute({
      sql:
        "INSERT INTO seen_webhook_deliveries (event_key, seen_at) VALUES (?, ?), (?, ?)",
      args: ["old", Date.now() - 8 * 86400_000, "recent", Date.now()],
    });
  }
  return result;
};

const { app } = await import("../../main.ts");
assertEquals(events, ["migrations-complete", "webhook-gc"]);
assert(
  queries.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS migrations")),
);
assert(
  queries.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS bookmarks")),
);
assert(
  queries.some((sql) =>
    sql.includes("CREATE TABLE IF NOT EXISTS preview_enrichment_jobs")
  ),
);
assertEquals(
  intervals,
  [],
  "Testing startup must not schedule background worker",
);
const rows = await db.execute({
  sql: "SELECT event_key FROM seen_webhook_deliveries ORDER BY event_key",
  args: [],
});
assertEquals(
  rows.rows,
  scenario === "gc-failure" ? [["old"], ["recent"]] : [["recent"]],
);

if (scenario === "eager") {
  assertEquals(getBaseUrl(), "https://configured.example");
  assert(getOAuth());
} else {
  assertThrows(() => getOAuth(), Error, "OAuth not initialized");
}
const handler = app.handler();
const request = new Request(
  "http://127.0.0.1:8888/oauth-client-metadata.json",
  {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "public.example:443",
    },
  },
);
const response = await handler(request);
assertEquals(response.status, 200);
const metadata = await response.json();
const expectedBase = scenario === "eager"
  ? "https://configured.example"
  : "https://public.example";
assertEquals(getBaseUrl(), expectedBase);
assertEquals(metadata.client_id, `${expectedBase}/oauth-client-metadata.json`);
assertEquals(metadata.redirect_uris, [`${expectedBase}/oauth/callback`]);
assertEquals(
  request.url,
  "http://127.0.0.1:8888/oauth-client-metadata.json",
  "Trust proxy must not mutate raw Request URL",
);
await (await handler(new Request("http://different.example/api/health"))).body
  ?.cancel();
assertEquals(getBaseUrl(), expectedBase, "OAuth derivation remains one-shot");
assertEquals(intervals, []);

// Exercise worker scheduling directly without running even one callback. Main
// stays test-mode so dotenv cannot load a credential-bearing environment file.
startPreviewEnrichmentWorker();
assertEquals(intervals, []);
Deno.env.delete("KIPCLIP_TESTING");
startPreviewEnrichmentWorker();
startPreviewEnrichmentWorker();
assertEquals(intervals, [60_000], "Default worker starts exactly once");
const isolatedWorker = await import(
  `../../lib/preview-enrichment-worker.ts?fixture=${scenario}`
);
isolatedWorker.startPreviewEnrichmentWorker({ intervalMs: 1234 });
isolatedWorker.startPreviewEnrichmentWorker({ intervalMs: 9999 });
assertEquals(
  intervals,
  [60_000, 1234],
  "Configured worker interval is honored once",
);
Deno.env.set("KIPCLIP_TESTING", "1");
console.log = log;
console.log(
  "MIGRATION_PROBE " +
    JSON.stringify({
      scenario,
      events,
      intervals,
      gcRows: rows.rows,
      baseUrl: getBaseUrl(),
      migrations: logs.filter((line) =>
        line.startsWith("✅ Completed migration on primary:")
      ).length,
    }),
);
