import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import {
  assertIsolated,
  assertSecurity,
  withMockFetch,
} from "./migration/isolation.ts";

assertIsolated();
const handler = app.handler();
const origin = "https://migration.example";

Deno.test("migration public proxy cold failure, recovery and stale fail-open keep HTTP/cache contracts", async () => {
  let fail = true;
  const now = Date.now;
  let elapsed = 0;
  Date.now = () => now() + elapsed;
  try {
    await withMockFetch(
      () => fail ? new Response(null, { status: 503 }) : Response.json({}),
      async (calls) => {
        const expected = {
          reviews: { reviews: [], stale: true },
          mentions: { mentions: [], stale: true },
          supporters: { supporters: [], totalCount: 0, stale: true },
        };
        const check = async (stale: boolean) => {
          for (const [route, value] of Object.entries(expected)) {
            const res = await handler(new Request(`${origin}/api/${route}`));
            assertEquals(res.status, 200);
            assertEquals(
              res.headers.get("cache-control"),
              "public, max-age=60, stale-while-revalidate=600",
            );
            assertSecurity(res);
            assertEquals(await res.json(), { ...value, stale });
          }
        };
        await check(true); // No cache yet: empty fallback, marked stale.
        assertEquals(calls.length, 3);
        fail = false;
        await check(false); // Failed fetches did not poison the cache.
        assertEquals(calls.length, 6);
        fail = true;
        await check(false); // Within24h TTL: no upstream fetch at all.
        assertEquals(calls.length, 6);
        elapsed = 25 * 60 * 60 * 1000;
        await check(true); // Past TTL: previous successful value is retained.
        assertEquals(calls.length, 9);
      },
    );
  } finally {
    Date.now = now;
  }
});
