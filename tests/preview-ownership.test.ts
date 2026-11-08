import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { assert, assertEquals } from "@std/assert";
import { clearMirrorTables, db } from "./mirror-test-setup.ts";
import { deleteBookmark, upsertBookmark } from "../mirror/upserts.ts";
import {
  claimPreviewEnrichmentJobs,
  enqueueMissingPreviewJobsForDid,
  markPreviewJobRetry,
} from "../lib/preview-enrichment-jobs.ts";
import { processPreviewEnrichmentJob } from "../lib/preview-enrichment-worker.ts";
import { writeAnnotation } from "../lib/annotations.ts";
const did = "did:plc:previewrace",
  uri = `at://${did}/community.lexicon.bookmarks.bookmark/a`;
async function seed(subject = "https://old.example", cid = "old") {
  await upsertBookmark({
    uri,
    did,
    rkey: "a",
    cid,
    subject,
    createdAt: new Date().toISOString(),
  });
  await enqueueMissingPreviewJobsForDid(did);
}

for (const change of ["subject", "delete"] as const) {
  Deno.test(`old preview cannot write or settle replacement after ${change}`, async () => {
    await clearMirrorTables();
    await seed();
    const [job] = await claimPreviewEnrichmentJobs();
    let writes = 0;
    await processPreviewEnrichmentJob(job, {
      restoreSession: () => Promise.resolve({ did }),
      readSource: () => Promise.resolve("commit"),
      readAnnotation: () => Promise.resolve(null),
      extractUrlMetadata: async () => {
        if (change === "delete") await deleteBookmark(uri, did);
        else await seed("https://new.example", "new");
        return { title: "OLD title", image: "https://old.example/image" };
      },
      writeAnnotation: () => {
        writes++;
        return Promise.resolve({ ok: true });
      },
    });
    assertEquals(writes, 0);
    assertEquals(
      (await db.execute({ sql: "SELECT COUNT(*) FROM annotations", args: [] }))
        .rows[0][0],
      0,
    );
    const rows = await db.execute({
      sql: "SELECT subject, status, attempts FROM preview_enrichment_jobs",
      args: [],
    });
    assertEquals(
      rows.rows,
      change === "delete" ? [] : [["https://new.example", "pending", 0]],
    );
  });
}

Deno.test("preview lease expiry and reactivation reject stale finishes", async () => {
  await clearMirrorTables();
  await seed();
  const [old] = await claimPreviewEnrichmentJobs();
  assertEquals(await claimPreviewEnrichmentJobs(), []);
  await db.execute({
    sql: "UPDATE preview_enrichment_jobs SET lease_until=0",
    args: [],
  });
  const [current] = await claimPreviewEnrichmentJobs();
  assert(current);
  assert(current.leaseToken !== old.leaseToken);
  await markPreviewJobRetry({ ...old, attempts: 2 }, new Error("late failure"));
  assertEquals(
    (await db.execute({
      sql: "SELECT status, attempts FROM preview_enrichment_jobs",
      args: [],
    })).rows[0],
    ["running", 0],
  );
  await markPreviewJobRetry(current, new Error("current failure"));
  assertEquals(
    (await db.execute({
      sql: "SELECT status, attempts FROM preview_enrichment_jobs",
      args: [],
    })).rows[0],
    ["pending", 1],
  );
});

Deno.test("preview source and absent annotation are fenced in the actual PDS put payload", async () => {
  await clearMirrorTables();
  await seed();
  const [job] = await claimPreviewEnrichmentJobs();
  let payload: any;
  const session = {
    did,
    pdsUrl: "https://pds.test",
    makeRequest: (_method: string, endpoint: string, options?: any) => {
      if (endpoint.includes("getLatestCommit")) {
        return Promise.resolve(Response.json({
          cid: "commit-before-reads",
        }));
      }
      if (endpoint.includes("getRecord")) {
        return Promise.resolve(Response.json({
          cid: job.sourceCid,
          value: { subject: job.subject },
        }));
      }
      payload = JSON.parse(options.body);
      return Promise.resolve(Response.json({
        uri: `at://${did}/com.kipclip.annotation/a`,
        cid: "annotation",
      }));
    },
  };
  await processPreviewEnrichmentJob(job, {
    restoreSession: () => Promise.resolve(session),
    readAnnotation: () => Promise.resolve(null),
    extractUrlMetadata: () =>
      Promise.resolve({
        title: "Current title",
        image: "https://old.example/image",
      }),
  });
  assertEquals(payload.swapRecord, null);
  assertEquals(payload.swapCommit, "commit-before-reads");
  assertEquals(
    (await db.execute({
      sql: "SELECT status FROM preview_enrichment_jobs",
      args: [],
    })).rows[0][0],
    "done",
  );
  // The helper also preserves an explicit null through JSON serialization.
  assert(
    await writeAnnotation(session, "a", { subject: uri }, { swapRecord: null }),
  );
  assertEquals(payload.swapRecord, null);
});

Deno.test("remote source change or deletion stops preview before any put", async () => {
  await clearMirrorTables();
  await seed();
  const [job] = await claimPreviewEnrichmentJobs();
  let writes = 0;
  const session = {
    did,
    pdsUrl: "https://pds.test",
    makeRequest: (_m: string, url: string) =>
      Promise.resolve(
        url.includes("getLatestCommit")
          ? Response.json({ cid: "commit" })
          : Response.json({
            cid: "changed",
            value: { subject: "https://new.example" },
          }),
      ),
  };
  await processPreviewEnrichmentJob(job, {
    restoreSession: () => Promise.resolve(session),
    readAnnotation: () => Promise.resolve(null),
    extractUrlMetadata: () => Promise.resolve({ title: "Old" }),
    writeAnnotation: () => {
      writes++;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(writes, 0);
});

Deno.test("PDS commit conflict after source reads retries without mirroring stale metadata", async () => {
  await clearMirrorTables();
  await seed();
  const [job] = await claimPreviewEnrichmentJobs();
  let currentCommit = "first", puts = 0;
  const session = {
    did,
    pdsUrl: "https://pds.test",
    makeRequest: (_method: string, url: string, options?: any) => {
      if (url.includes("getLatestCommit")) {
        return Promise.resolve(
          Response.json({ cid: currentCommit }),
        );
      }
      if (url.includes("getRecord")) {
        return Promise.resolve(
          Response.json({
            cid: job.sourceCid,
            value: { subject: job.subject },
          }),
        );
      }
      puts++;
      const body = JSON.parse(options.body);
      assertEquals(body.swapCommit, "first");
      assertEquals(currentCommit, "changed-after-read");
      return Promise.resolve(
        Response.json({ error: "InvalidSwap" }, { status: 400 }),
      );
    },
  };
  await processPreviewEnrichmentJob(job, {
    restoreSession: () => Promise.resolve(session),
    extractUrlMetadata: () => Promise.resolve({ title: "Stale" }),
    readAnnotation: () => {
      currentCommit = "changed-after-read";
      return Promise.resolve(null);
    },
  });
  assertEquals(puts, 1);
  assertEquals(
    (await db.execute({ sql: "SELECT COUNT(*) FROM annotations", args: [] }))
      .rows[0][0],
    0,
  );
  assertEquals(
    (await db.execute({
      sql: "SELECT status, attempts FROM preview_enrichment_jobs",
      args: [],
    })).rows[0],
    ["pending", 1],
  );
});
