import { writeAnnotation as writeAnnotationRecord } from "./annotations.ts";
import { extractUrlMetadata as extractUrlMetadataRecord } from "./enrichment.ts";
import { getOAuth } from "./oauth-config.ts";
import {
  claimPreviewEnrichmentJobs,
  enqueueMissingPreviewJobsForSessionDids,
  hasUsableAnnotation,
  markPreviewJobBlockedNoSession,
  markPreviewJobDone,
  markPreviewJobRetry,
  type PreviewEnrichmentJob,
} from "./preview-enrichment-jobs.ts";
import { ANNOTATION_COLLECTION } from "./route-utils.ts";
import { upsertAnnotation as upsertAnnotationRecord } from "../mirror/upserts.ts";
import type { AnnotationRecord } from "../shared/types.ts";

export interface PreviewEnrichmentStats {
  processed: number;
  success: number;
  retry: number;
  stopped: number;
  skippedNoSession: number;
  skippedExisting: number;
  enqueued: number;
}

export interface PreviewWorkerOptions {
  batchSize?: number;
  intervalMs?: number;
  enqueueDidBatchSize?: number;
  enqueuePerDidLimit?: number;
}

export interface PreviewWorkerDeps {
  restoreSession?: (did: string) => Promise<any | null>;
  hasUsableAnnotation?: (bookmarkUri: string) => Promise<boolean>;
  extractUrlMetadata?: typeof extractUrlMetadataRecord;
  writeAnnotation?: typeof writeAnnotationRecord;
  upsertAnnotation?: typeof upsertAnnotationRecord;
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let enqueueOffset = 0;

function emptyStats(): PreviewEnrichmentStats {
  return {
    processed: 0,
    success: 0,
    retry: 0,
    stopped: 0,
    skippedNoSession: 0,
    skippedExisting: 0,
    enqueued: 0,
  };
}

async function restoreSession(did: string): Promise<any | null> {
  try {
    return await getOAuth().sessions.getOAuthSession(did);
  } catch {
    return null;
  }
}

export async function processPreviewEnrichmentJob(
  job: PreviewEnrichmentJob,
  deps: PreviewWorkerDeps = {},
): Promise<PreviewEnrichmentStats> {
  const stats = emptyStats();
  stats.processed = 1;

  const checkAnnotation = deps.hasUsableAnnotation ?? hasUsableAnnotation;
  const getSession = deps.restoreSession ?? restoreSession;
  const extractMetadata = deps.extractUrlMetadata ?? extractUrlMetadataRecord;
  const putAnnotation = deps.writeAnnotation ?? writeAnnotationRecord;
  const mirrorAnnotation = deps.upsertAnnotation ?? upsertAnnotationRecord;

  try {
    if (await checkAnnotation(job.bookmarkUri)) {
      await markPreviewJobDone(job.bookmarkUri);
      stats.skippedExisting = 1;
      return stats;
    }

    const oauthSession = await getSession(job.did);
    if (!oauthSession) {
      await markPreviewJobBlockedNoSession(job);
      stats.skippedNoSession = 1;
      return stats;
    }

    const metadata = await extractMetadata(job.subject);
    if (await checkAnnotation(job.bookmarkUri)) {
      await markPreviewJobDone(job.bookmarkUri);
      stats.skippedExisting = 1;
      return stats;
    }
    const annotation: AnnotationRecord = {
      subject: job.bookmarkUri,
      title: metadata.title,
      description: metadata.description,
      favicon: metadata.favicon,
      image: metadata.image,
      createdAt: new Date().toISOString(),
    };

    const result = await putAnnotation(oauthSession, job.rkey, annotation);
    if (!result.ok) throw new Error("annotation write failed");

    await mirrorAnnotation({
      uri: result.uri ?? `at://${job.did}/${ANNOTATION_COLLECTION}/${job.rkey}`,
      did: job.did,
      rkey: job.rkey,
      cid: result.cid ?? "",
      subject: job.bookmarkUri,
      title: annotation.title ?? null,
      description: annotation.description ?? null,
      favicon: annotation.favicon ?? null,
      image: annotation.image ?? null,
      note: null,
    });
    await markPreviewJobDone(job.bookmarkUri);
    stats.success = 1;
  } catch (err) {
    const status = await markPreviewJobRetry(job, err);
    if (status === "failed") stats.stopped = 1;
    else stats.retry = 1;
  }
  return stats;
}

export async function runPreviewEnrichmentTick(
  options: PreviewWorkerOptions = {},
): Promise<PreviewEnrichmentStats> {
  if (running) return emptyStats();
  running = true;
  const total = emptyStats();
  try {
    const didLimit = options.enqueueDidBatchSize ?? 10;
    const enqueued = await enqueueMissingPreviewJobsForSessionDids(
      didLimit,
      options.enqueuePerDidLimit ?? 25,
      enqueueOffset,
    );
    total.enqueued = enqueued.enqueued;
    enqueueOffset = enqueued.dids < didLimit ? 0 : enqueueOffset + didLimit;

    const jobs = await claimPreviewEnrichmentJobs(options.batchSize ?? 5);
    for (const job of jobs) {
      const stats = await processPreviewEnrichmentJob(job);
      total.processed += stats.processed;
      total.success += stats.success;
      total.retry += stats.retry;
      total.stopped += stats.stopped;
      total.skippedNoSession += stats.skippedNoSession;
      total.skippedExisting += stats.skippedExisting;
      total.enqueued += stats.enqueued;
    }
    if (total.processed > 0 || total.enqueued > 0) {
      console.log("[preview-enrichment] tick", total);
    }
    return total;
  } finally {
    running = false;
  }
}

export function startPreviewEnrichmentWorker(
  options: PreviewWorkerOptions = {},
): void {
  if (timer !== undefined || Deno.env.get("KIPCLIP_TESTING")) return;
  const intervalMs = options.intervalMs ?? 60_000;
  timer = setInterval(() => {
    runPreviewEnrichmentTick(options).catch((err) =>
      console.warn("[preview-enrichment] tick failed", err)
    );
  }, intervalMs);
}
