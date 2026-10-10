import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assertEquals } from "@std/assert";
import { app } from "../main.ts";
import {
  compareContract,
  type Observation,
  observe,
} from "./migration/contracts.ts";
import { caseRequest, routeCases } from "./migration/route-cases.ts";
import {
  assertIsolated,
  loopbackInfo,
  withMockFetch,
} from "./migration/isolation.ts";

assertIsolated();
const baseline: Record<string, Observation> = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/migration-route-baseline.json", import.meta.url),
  ),
);
const handler = app.handler();

Deno.test("migration recorded baseline covers every unique shared route case", () => {
  const names = routeCases.map((testCase) => testCase.name);
  assertEquals(new Set(names).size, names.length);
  assertEquals(Object.keys(baseline).sort(), [...names].sort());
});

for (const testCase of routeCases) {
  Deno.test(`migration recorded baseline contract: ${testCase.name}`, async () => {
    await withMockFetch((request) => {
      throw new Error(`Contract attempted external fetch: ${request.url}`);
    }, async () => {
      await compareContract(
        () => caseRequest(testCase),
        () => Promise.resolve(baseline[testCase.name]),
        async (request) => observe(await handler(request, loopbackInfo())),
      );
    });
  });
}
