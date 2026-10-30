import "../../runtime/deno/install.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";

const { app } = await import("../../main.ts");
const { setTestSessionProvider } = await import("../../lib/session.ts");
const { createMockSessionResult } = await import("../test-helpers.ts");
let calls = 0;
globalThis.fetch = () => {
  calls++;
  throw new Error("Unexpected network request");
};
setTestSessionProvider(() => Promise.resolve(createMockSessionResult()));

async function patchSettings(settings: Record<string, unknown>): Promise<Response> {
  return await app.handler()(new Request("https://kipclip.com/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  }));
}

for (const settings of [
  { instapaperEnabled: true, instapaperUsername: "test@example.invalid", instapaperPassword: "test-password" },
  { instapaperEnabled: false, instapaperUsername: "test@example.invalid" },
  { instapaperEnabled: false, instapaperPassword: "test-password" },
]) {
  const response = await patchSettings(settings);
  assertEquals(response.status, 503);
  const body = await response.json();
  assertStringIncludes(body.error, "temporarily unavailable");
  assertEquals(JSON.stringify(body).includes("test-password"), false);
}
assertEquals(calls, 0);
assertEquals((await patchSettings({ instapaperEnabled: false })).status, 200);
assertEquals(calls, 0);
