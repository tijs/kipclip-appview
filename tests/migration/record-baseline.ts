import "../../runtime/deno/install.ts";
/** Read-only recorder. Prints fixtures; never overwrites the reviewed oracle. */
import { app } from "../../main.ts";
import { observe } from "./contracts.ts";
import { caseRequest, routeCases } from "./route-cases.ts";
import { assertIsolated, loopbackInfo, withMockFetch } from "./isolation.ts";

assertIsolated();
const handler = app.handler();
const result: Record<string, unknown> = {};
await withMockFetch((request) => {
  throw new Error(
    `Baseline recording attempted external fetch: ${request.url}`,
  );
}, async () => {
  for (const testCase of routeCases) {
    result[testCase.name] = await observe(
      await handler(caseRequest(testCase), loopbackInfo()),
    );
  }
});
console.log("MIGRATION_BASELINE " + JSON.stringify(result));
