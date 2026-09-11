/**
 * Tests for lib/drift-audit.ts — mirror-vs-PDS drift detection.
 */

import "./test-setup.ts";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { auditTrackedDrift } from "../lib/drift-audit.ts";
import {
  MISSING_REPO_RECHECK_COOLDOWN_MS,
  recordMissingRepo,
} from "../lib/missing-repo.ts";

const DID = "did:plc:drift123";
const PDS = "https://pds.example.test";

async function withClean<T>(fn: () => Promise<T>): Promise<T> {
  await clearMirrorTables();
  try {
    return await fn();
  } finally {
    await clearMirrorTables();
  }
}

function repoNotFoundResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "RepoNotFound",
      message: "Could not find repo for DID",
    }),
    { status: 400 },
  );
}

Deno.test("auditTrackedDrift skips PDS check for DIDs in missing-repo cooldown", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });
    await recordMissingRepo(DID);

    const result = await auditTrackedDrift();

    assertEquals(result.rows.length, 1);
    assertEquals(result.rows[0].did, DID);
    assertEquals(result.rows[0].mirror, 0);
    assertEquals(result.rows[0].pds, null);
    assertStringIncludes(result.rows[0].pdsError ?? "", "repo marked missing");
    // Known-missing cooldown rows are explicitly reported as SKIPPED, not
    // lumped into errors or hidden behind checked=0.
    assertEquals(result.rows[0].skipped, true);
    assertEquals(result.errors.length, 0);
    assertEquals(result.skipped.length, 1);
    assertEquals(result.skipped[0].did, DID);
  });
});

Deno.test("auditTrackedDrift records missing repo when PDS returns RepoNotFound", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(repoNotFoundResponse())) as typeof globalThis.fetch;
    try {
      const result = await auditTrackedDrift();
      assertEquals(result.rows.length, 1);
      assertStringIncludes(result.rows[0].pdsError ?? "", "RepoNotFound");
      assertEquals(result.rows[0].pdsErrorClass, "reponotfound");
      assertEquals(result.rows[0].skipped, false);
      assertEquals(result.errors.length, 1);

      const missing = await db.execute({
        sql: "SELECT did, missing_count FROM missing_repos WHERE did = ?",
        args: [DID],
      });
      assertEquals(missing.rows.length, 1);
      assertEquals(missing.rows[0][1], 1);

      // The same confirmation is recorded in the quarantine state book.
      const state = await db.execute({
        sql: "SELECT state, last_error_class FROM tap_repo_state WHERE did = ?",
        args: [DID],
      });
      assertEquals(state.rows.length, 1);
      assertEquals(state.rows[0][0], "missing");
      assertEquals(state.rows[0][1], "reponotfound");
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift classifies a 5xx PDS as unavailable, never missing", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "InternalError", message: "boom" }),
          { status: 503 },
        ),
      )) as typeof globalThis.fetch;
    try {
      const result = await auditTrackedDrift();
      assertEquals(result.rows[0].pdsErrorClass, "server-error");
      assertEquals(result.errors.length, 1);

      const missing = await db.execute({
        sql: "SELECT 1 FROM missing_repos WHERE did = ?",
        args: [DID],
      });
      assertEquals(missing.rows.length, 0);

      const state = await db.execute({
        sql:
          "SELECT state, next_check_at, last_checked_at FROM tap_repo_state WHERE did = ?",
        args: [DID],
      });
      assertEquals(state.rows.length, 1);
      assertEquals(state.rows[0][0], "unavailable");
      assertEquals(Number(state.rows[0][1]) > Number(state.rows[0][2]), true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift suppresses probing during unavailable-PDS cooldown", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    let listRecordsCalls = 0;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("listRecords")) listRecordsCalls++;
      return Promise.resolve(
        new Response("PDS down", { status: 503 }),
      ) as unknown as Promise<Response>;
    }) as typeof globalThis.fetch;
    try {
      const first = await auditTrackedDrift();
      assertEquals(first.rows[0].pdsErrorClass, "server-error");

      // Second run within the cooldown must not re-probe the PDS.
      const second = await auditTrackedDrift();
      assertEquals(second.rows[0].skipped, true);
      assertEquals(second.rows[0].pdsErrorClass, "cooldown-unavailable");
      assertEquals(second.skipped.length, 1);
      assertEquals(second.errors.length, 0);
      // One listRecords probe on the first run; zero on the cooldown run.
      assertEquals(listRecordsCalls, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift clears quarantine state when the repo recovers", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    let healthy = false;
    globalThis.fetch = (() => {
      if (!healthy) return Promise.resolve(repoNotFoundResponse());
      return Promise.resolve(
        new Response(JSON.stringify({ records: [] }), { status: 200 }),
      ) as unknown as Promise<Response>;
    }) as typeof globalThis.fetch;
    try {
      await auditTrackedDrift();
      const before = await db.execute({
        sql: "SELECT COUNT(*) FROM tap_repo_state WHERE did = ?",
        args: [DID],
      });
      assertEquals(Number(before.rows[0][0]), 1);

      // The repo comes back; age the missing-repo row past the recheck
      // cooldown exactly like the daily audit would see it after 7 days.
      healthy = true;
      const old = Date.now() - MISSING_REPO_RECHECK_COOLDOWN_MS - 1;
      await db.execute({
        sql: "UPDATE missing_repos SET last_missing_at = ? WHERE did = ?",
        args: [old, DID],
      });
      const result = await auditTrackedDrift();
      assertEquals(result.rows[0].pdsError, null);
      const after = await db.execute({
        sql: "SELECT COUNT(*) FROM tap_repo_state WHERE did = ?",
        args: [DID],
      });
      assertEquals(Number(after.rows[0][0]), 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift clears missing repo when PDS returns records after cooldown", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });
    const stale = Date.now() - MISSING_REPO_RECHECK_COOLDOWN_MS - 1;
    await db.execute({
      sql:
        "INSERT INTO missing_repos (did, first_missing_at, last_missing_at, missing_count) VALUES (?, ?, ?, 1)",
      args: [DID, stale, stale],
    });

    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ records: [] }), { status: 200 }),
      )) as typeof globalThis.fetch;
    try {
      const result = await auditTrackedDrift();
      assertEquals(result.rows.length, 1);
      assertEquals(result.rows[0].pdsError, null);
      assertEquals(result.errors.length, 0);

      const missing = await db.execute({
        sql: "SELECT 1 FROM missing_repos WHERE did = ?",
        args: [DID],
      });
      assertEquals(missing.rows.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift migrates PDS instead of marking missing when old PDS returns RepoNotFound", async () => {
  await withClean(async () => {
    const newPds = "https://new-pds.example.test";
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    globalThis.fetch = ((
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://plc.directory/")) {
        return Promise.resolve(
          Response.json({
            id: DID,
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: newPds,
              },
            ],
          }),
        );
      }
      if (url.startsWith(`${PDS}/`)) {
        return Promise.resolve(repoNotFoundResponse());
      }
      if (url.startsWith(`${newPds}/`)) {
        return Promise.resolve(
          new Response(JSON.stringify({ records: [] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;
    try {
      const result = await auditTrackedDrift();
      assertEquals(result.rows.length, 1);
      assertEquals(result.rows[0].did, DID);
      assertEquals(result.rows[0].pdsError, null);
      assertEquals(result.rows[0].pdsMigrated?.from, PDS);
      assertEquals(result.rows[0].pdsMigrated?.to, newPds);
      assertEquals(result.errors.length, 0);

      const tracked = await db.execute({
        sql: "SELECT pds_url FROM tracked_dids WHERE did = ?",
        args: [DID],
      });
      assertEquals(tracked.rows[0][0], newPds);

      const missing = await db.execute({
        sql: "SELECT 1 FROM missing_repos WHERE did = ?",
        args: [DID],
      });
      assertEquals(missing.rows.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift does not record missing repo on non-404/400 RepoNotFound text", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "InternalError",
            message: "Could not find repo in secondary index",
          }),
          { status: 500 },
        ),
      )) as typeof globalThis.fetch;
    try {
      const result = await auditTrackedDrift();
      assertEquals(result.rows.length, 1);
      assertNotEquals(result.rows[0].pdsError ?? "", "");
      assertStringIncludes(result.rows[0].pdsError ?? "", "500");

      const missing = await db.execute({
        sql: "SELECT 1 FROM missing_repos WHERE did = ?",
        args: [DID],
      });
      assertEquals(missing.rows.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift caps PDS pagination to prevent unbounded loops", async () => {
  await withClean(async () => {
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            records: [{ uri: `at://${DID}/x/y` }],
            cursor: "next",
          }),
          { status: 200 },
        ),
      );
    }) as typeof globalThis.fetch;
    try {
      const result = await auditTrackedDrift();
      assertEquals(result.rows.length, 1);
      assertEquals(result.rows[0].pdsError, null);
      assertEquals(result.rows[0].pds, 200);
      assertEquals(calls, 200);
    } finally {
      globalThis.fetch = original;
    }
  });
});

Deno.test("auditTrackedDrift records missing repo when resolved PDS also returns RepoNotFound", async () => {
  await withClean(async () => {
    const newPds = "https://new-pds.example.test";
    await db.execute({
      sql: "INSERT INTO tracked_dids (did, pds_url, added_at) VALUES (?, ?, ?)",
      args: [DID, PDS, Date.now()],
    });

    const original = globalThis.fetch;
    globalThis.fetch = ((
      input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://plc.directory/")) {
        return Promise.resolve(
          Response.json({
            id: DID,
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint: newPds,
              },
            ],
          }),
        );
      }
      return Promise.resolve(repoNotFoundResponse());
    }) as typeof globalThis.fetch;
    try {
      const result = await auditTrackedDrift();
      assertEquals(result.rows.length, 1);
      assertEquals(result.rows[0].did, DID);
      assertStringIncludes(result.rows[0].pdsError ?? "", "RepoNotFound");
      assertEquals(result.errors.length, 1);

      const tracked = await db.execute({
        sql: "SELECT pds_url FROM tracked_dids WHERE did = ?",
        args: [DID],
      });
      assertEquals(tracked.rows[0][0], PDS);

      const missing = await db.execute({
        sql: "SELECT missing_count FROM missing_repos WHERE did = ?",
        args: [DID],
      });
      assertEquals(missing.rows.length, 1);
      assertEquals(missing.rows[0][0], 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
