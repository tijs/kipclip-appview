import { assertEquals } from "@std/assert";
import {
  preferencesFromResponse,
  refreshLivePreferences,
} from "../frontend/lib/preferences-response.ts";

Deno.test("live preferences refresh unwraps the API response without corrupting state", () => {
  const preferences = { dateFormat: "eu", readingListTag: "later" };
  assertEquals(preferencesFromResponse({ preferences }), preferences);
  for (
    const invalid of [null, {}, preferences, { preferences: null }, {
      preferences: { dateFormat: "us" },
    }, { preferences: { dateFormat: "us", readingListTag: 1 } }]
  ) {
    assertEquals(preferencesFromResponse(invalid), null);
  }
});

Deno.test("live refetch applies wrapped preferences and ignores invalid responses", async () => {
  const applied: unknown[] = [];
  const apply = (value: unknown) => applied.push(value);
  const preferences = { dateFormat: "eu", readingListTag: "later" };
  await refreshLivePreferences(
    () => Promise.resolve(Response.json({ preferences })),
    apply,
  );
  await refreshLivePreferences(
    () =>
      Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 })),
    apply,
  );
  await refreshLivePreferences(
    () => Promise.resolve(Response.json({ preferences: {} })),
    apply,
  );
  assertEquals(applied, [preferences]);
});
