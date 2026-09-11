/**
 * Tests for lib/tap-delete.ts — verified TAP-side repo-row deletion.
 *
 * Pins (release blockers):
 *   - Deletion READS BACK the exact target: DIDs that survive the DELETE are
 *     reported via a thrown error (naming the survivors), never claimed
 *     successful.
 *   - DIDs that were never enrolled are reported as `alreadyAbsent`
 *     (idempotent no-op, mirroring TAP /repos/remove semantics).
 *   - A DELETE that itself fails propagates (nothing silently destroyed).
 *   - The read-back logic is exercised against a FAKE client (no native
 *     libsql file handles in the unit path); one integration test covers the
 *     real withTapDb file path.
 */

import "./test-setup.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";

import {
  deleteTapRepoRows,
  deleteTapRepoRowsWithClient,
  type TapExecuteClient,
} from "../lib/tap-delete.ts";

/**
 * Fake libsql-ish client with positional-array rows. `survivors` behave as
 * if something keeps the row despite the DELETE (a swallowed delete);
 * `abortOnDelete` makes the DELETE itself throw.
 */
function fakeClient(opts: {
  repos: string[];
  survivors?: string[];
  abortOnDelete?: boolean;
}): TapExecuteClient {
  const rows = new Map(opts.repos.map((d) => [d, [d]]));
  const survivors = new Set(opts.survivors ?? []);
  return {
    execute(query: { sql: string; args?: unknown[] }) {
      const dids = (query.args ?? []).map(String);
      if (/^SELECT did FROM repos/.test(query.sql)) {
        return Promise.resolve({
          rows: [...rows.keys()].filter((d) => dids.includes(d)).sort().map((
            d,
          ) => [d]),
        });
      }
      if (/^DELETE FROM repos/.test(query.sql)) {
        if (opts.abortOnDelete) {
          return Promise.reject(new Error("row protected"));
        }
        for (const d of dids) {
          if (!survivors.has(d)) rows.delete(d);
        }
        return Promise.resolve({ rows: [] });
      }
      return Promise.reject(new Error(`unhandled sql: ${query.sql}`));
    },
  };
}

Deno.test("deleteTapRepoRowsWithClient deletes, reads back, and reports already-absent DIDs", async () => {
  const client = fakeClient({ repos: ["did:plc:gone", "did:plc:keep"] });
  const res = await deleteTapRepoRowsWithClient(client, [
    "did:plc:gone",
    "did:plc:absent",
  ]);
  assertEquals(res.removed, ["did:plc:gone"]);
  assertEquals(res.alreadyAbsent, ["did:plc:absent"]);
  // Read back through the same client: gone is gone, keep is untouched.
  const remaining = await client.execute({
    sql: "SELECT did FROM repos WHERE did IN (?, ?)",
    args: ["did:plc:keep", "did:plc:gone"],
  });
  assertEquals(remaining.rows.map((r) => String(r[0])), ["did:plc:keep"]);
});

Deno.test("deleteTapRepoRowsWithClient read-back verification throws naming the survivor", async () => {
  // The DELETE "succeeds" but the survivor stays — exactly the survival a
  // read-back is meant to catch, and the reason success must never be
  // claimed before verification.
  const client = fakeClient({
    repos: ["did:plc:fine", "did:plc:stuck"],
    survivors: ["did:plc:stuck"],
  });
  await assertRejects(
    () =>
      deleteTapRepoRowsWithClient(client, ["did:plc:fine", "did:plc:stuck"]),
    Error,
    "read-back verification failed",
  );
  // The surviving DID is NAMED so operators know exactly what to fix.
  await deleteTapRepoRowsWithClient(client, ["did:plc:fine", "did:plc:stuck"])
    .then(() => {
      throw new Error("should have thrown");
    })
    .catch((err: Error) => {
      assertStringIncludes(err.message, "did:plc:stuck");
    });
});

Deno.test("deleteTapRepoRowsWithClient: DELETE failure propagates, nothing silently destroyed", async () => {
  const client = fakeClient({
    repos: ["did:plc:prot"],
    abortOnDelete: true,
  });
  await assertRejects(
    () => deleteTapRepoRowsWithClient(client, ["did:plc:prot"]),
    Error,
    "row protected",
  );
  const remaining = await client.execute({
    sql: "SELECT did FROM repos WHERE did IN (?)",
    args: ["did:plc:prot"],
  });
  assertEquals(remaining.rows.length, 1, "row must still be present");
});

Deno.test("deleteTapRepoRows: empty request is a no-op", async () => {
  assertEquals(await deleteTapRepoRows([]), {
    removed: [],
    alreadyAbsent: [],
  });
});

Deno.test("integration: deleteTapRepoRows works against a real temp libsql file", async () => {
  // One integration check over the real withTapDb/@libsql client path —
  // already-absent reporting and exact read-back included.
  const tmp = await Deno.makeTempFile({ suffix: ".db" });
  const { createClient } = await import("@libsql/client");
  const tap = createClient({ url: `file:${tmp}` });
  try {
    await tap.execute("CREATE TABLE repos (did TEXT PRIMARY KEY)");
    await tap.execute("INSERT INTO repos (did) VALUES ('did:plc:gone')");
    await tap.execute("INSERT INTO repos (did) VALUES ('did:plc:keep')");
    tap.close();

    const res = await deleteTapRepoRows(["did:plc:gone", "did:plc:absent"], {
      tapDbPath: tmp,
    });
    assertEquals(res.removed, ["did:plc:gone"]);
    assertEquals(res.alreadyAbsent, ["did:plc:absent"]);

    const verify = createClient({ url: `file:${tmp}` });
    try {
      const remaining = await verify.execute({
        sql: "SELECT did FROM repos ORDER BY did",
        args: [],
      });
      // libsql Rows are array-indexable (r[0]) while stringify/compare as
      // objects; assert through the same numeric access production uses.
      const rows = remaining.rows as unknown as unknown[][];
      assertEquals(rows.map((r) => String(r[0])), ["did:plc:keep"]);
    } finally {
      verify.close();
    }
  } finally {
    await Deno.remove(tmp).catch(() => {});
    await Deno.remove(`${tmp}-wal`).catch(() => {});
    await Deno.remove(`${tmp}-shm`).catch(() => {});
  }
});
