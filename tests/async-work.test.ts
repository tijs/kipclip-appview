import { assertEquals, assertRejects } from "@std/assert";
import { createTrailingTask } from "../shared/async-work.ts";

Deno.test("serialized work retains trailing intent and every caller waits for it", async () => {
  const releases: (() => void)[] = [];
  let runs = 0, concurrent = 0, maximum = 0;
  const task = createTrailingTask(async () => {
    runs++;
    concurrent++;
    maximum = Math.max(maximum, concurrent);
    await new Promise<void>((r) => releases.push(r));
    concurrent--;
    return runs;
  });
  const a = task();
  await Promise.resolve();
  const b = task(), c = task();
  let settled = false;
  c.then(() => settled = true);
  assertEquals(a, b);
  assertEquals(b, c);
  assertEquals(runs, 1);
  releases.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(runs, 2);
  assertEquals(settled, false);
  releases.shift()!();
  assertEquals(await Promise.all([a, b, c]), [2, 2, 2]);
  assertEquals(maximum, 1);
});
Deno.test("a failed run still serves retained newer intent and a later call can retry", async () => {
  let reject!: (e: Error) => void;
  let runs = 0;
  const task = createTrailingTask(() => {
    runs++;
    return runs === 1
      ? new Promise<number>((_r, r) => reject = r)
      : Promise.resolve(runs);
  });
  const a = task();
  await Promise.resolve();
  task();
  reject(new Error("obsolete failed attempt"));
  assertEquals(await a, 2);
  let fails = true;
  const retry = createTrailingTask(async () => {
    if (fails) throw new Error("failure");
    return 1;
  });
  await assertRejects(retry, Error, "failure");
  fails = false;
  assertEquals(await retry(), 1);
});

Deno.test("a synchronous failure does not poison later requests", async () => {
  let fail = true;
  const task = createTrailingTask(() => {
    if (fail) throw new Error("synchronous");
    return Promise.resolve(1);
  });
  await assertRejects(task, Error, "synchronous");
  fail = false;
  assertEquals(await task(), 1);
});
