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
    assertEquals(result.errors.length, 1);
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
      assertEquals(result.errors.length, 1);

      const missing = await db.execute({
        sql: "SELECT did, missing_count FROM missing_repos WHERE did = ?",
        args: [DID],
      });
      assertEquals(missing.rows.length, 1);
      assertEquals(missing.rows[0][1], 1);
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
