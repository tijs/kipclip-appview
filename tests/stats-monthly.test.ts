/**
 * Tests for GET /api/stats/monthly and the lib/stats-monthly aggregator.
 * Uses the in-memory test database; main.ts runs migrations on import
 * so iron_session_storage and seen_dids exist before fixture inserts.
 */

import "./test-setup.ts";

import { assert, assertEquals } from "@std/assert";
import { app } from "../main.ts";
import { initOAuth } from "../lib/oauth-config.ts";
import { db } from "../lib/db.ts";
import { __testing__, MAX_MONTHS } from "../lib/stats-monthly.ts";

initOAuth(new URL("https://kipclip.com"));
const handler = app.handler();

async function clearFixtures(): Promise<void> {
  await db.execute({
    sql: "DELETE FROM iron_session_storage WHERE key LIKE 'session:did:%'",
    args: [],
  });
  await db.execute({ sql: "DELETE FROM seen_dids", args: [] });
  __testing__.resetCache();
}

async function insertSession(did: string, updatedAtMs: number): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO iron_session_storage (key, value, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    args: [
      `session:did:plc:${did}`,
      "{}",
      String(updatedAtMs + 14 * 86_400_000),
      String(updatedAtMs),
      String(updatedAtMs),
    ],
  });
}

async function insertSeenDid(
  did: string,
  firstSeenAtMs: number,
): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO seen_dids (did, first_seen_at, last_seen_at)
      VALUES (?, ?, ?)
    `,
    args: [`did:plc:${did}`, firstSeenAtMs, firstSeenAtMs],
  });
}

Deno.test("recentYearMonths returns chronological list ending at current month", () => {
  const now = new Date(Date.UTC(2026, 4, 15)); // 2026-05-15 UTC
  const months = __testing__.recentYearMonths(now, 4);
  assertEquals(months, ["2026-02", "2026-03", "2026-04", "2026-05"]);
});

Deno.test("ymToUtcRangeMs covers exactly the calendar month in UTC", () => {
  const { startMs, endMs } = __testing__.ymToUtcRangeMs("2026-05");
  assertEquals(startMs, Date.UTC(2026, 4, 1));
  assertEquals(endMs, Date.UTC(2026, 5, 1));
});

Deno.test("fetchMonthlyStats counts distinct DIDs per month + signups", async () => {
  await clearFixtures();
  const may = Date.UTC(2026, 4, 10);
  const apr = Date.UTC(2026, 3, 10);
  // Two distinct DIDs active in May, one with multiple sessions (still 1).
  await insertSession("alice", may);
  await insertSession("bob", may + 1);
  await db.execute({
    sql:
      `INSERT INTO iron_session_storage (key, value, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      "session:did:plc:alice-other", // different key, same DID prefix would still count distinct
      "{}",
      String(may + 14 * 86_400_000),
      String(may),
      String(may),
    ],
  });
  // One DID active only in April.
  await insertSession("carol", apr);

  // Signups: alice in April, bob in May.
  await insertSeenDid("alice", apr);
  await insertSeenDid("bob", may);

  const now = new Date(Date.UTC(2026, 4, 20));
  const stats = await __testing__.fetchMonthlyStats(3, now);

  assertEquals(stats.currentYearMonth, "2026-05");
  assertEquals(stats.months.map((m) => m.yearMonth), [
    "2026-03",
    "2026-04",
    "2026-05",
  ]);
  // March: nobody.
  assertEquals(stats.months[0].mau, 0);
  assertEquals(stats.months[0].signups, 0);
  // April: carol active, alice signed up.
  assertEquals(stats.months[1].mau, 1);
  assertEquals(stats.months[1].signups, 1);
  // May: alice + bob + alice-other = 3 distinct session keys.
  assertEquals(stats.months[2].mau, 3);
  assertEquals(stats.months[2].signups, 1);
});

Deno.test("fetchMonthlyStats ignores empty updated_at sentinel rows", async () => {
  await clearFixtures();
  // Row with empty updated_at (rows that survived the column-add
  // migration before they were re-touched). Must not contribute MAU.
  await db.execute({
    sql:
      `INSERT INTO iron_session_storage (key, value, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: ["session:did:plc:stale", "{}", null, "", ""],
  });
  const now = new Date(Date.UTC(2026, 4, 20));
  const stats = await __testing__.fetchMonthlyStats(2, now);
  for (const m of stats.months) assertEquals(m.mau, 0);
});

Deno.test("GET /api/stats/monthly returns months array + currentYearMonth", async () => {
  await clearFixtures();
  const now = Date.now();
  await insertSession("a", now);
  await insertSeenDid("a", now);

  const res = await handler(
    new Request("https://kipclip.com/api/stats/monthly?months=3"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.currentYearMonth, "string");
  assertEquals(body.months.length, 3);
  for (const m of body.months) {
    assert(
      typeof m.yearMonth === "string" && /^\d{4}-\d{2}$/.test(m.yearMonth),
    );
    assertEquals(typeof m.mau, "number");
    assertEquals(typeof m.signups, "number");
  }
  // Current month must contain our newly-inserted user.
  const current = body.months.find((m: { yearMonth: string }) =>
    m.yearMonth === body.currentYearMonth
  );
  assert(current);
  assert(current.mau >= 1);
  assert(current.signups >= 1);
  // Public, cacheable.
  const cc = res.headers.get("cache-control") ?? "";
  assert(cc.includes("public"));
});

Deno.test("GET /api/stats/monthly defaults to 12 months", async () => {
  await clearFixtures();
  const res = await handler(
    new Request("https://kipclip.com/api/stats/monthly"),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.months.length, 12);
});

Deno.test("GET /api/stats/monthly rejects out-of-range months", async () => {
  for (const bad of ["0", "-1", String(MAX_MONTHS + 1), "abc", "1.5e9"]) {
    const res = await handler(
      new Request(`https://kipclip.com/api/stats/monthly?months=${bad}`),
    );
    assertEquals(res.status, 400, `months=${bad} should 400`);
    await res.body?.cancel();
  }
});
