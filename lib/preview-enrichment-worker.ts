import {
  type PdsAnnotationRead,
  readAnnotationFromPds,
  writeAnnotation as writeAnnotationRecord,
} from "./annotations.ts";
import {
  extractUrlMetadata as extractUrlMetadataRecord,
  isNonEmptyUrlMetadata,
} from "./enrichment.ts";
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
import {
  isKnownDefaultYouTubeDescription,
  isKnownDefaultYouTubeTitle,
  parseYouTubeVideoUrl,
} from "./youtube-metadata.ts";
import type { AnnotationRecord, UrlMetadata } from "../shared/types.ts";

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
  /**
   * Authoritative annotation read for the merge base. Defaults to a
   * getRecord against the user's PDS (authenticated session + rkey). Returns
   * null when the PDS has no annotation (404); throws on any other failure so
   * the worker retries instead of merging/writing from a stale mirror.
   */
  readAnnotation?: (
    oauthSession: any,
    rkey: string,
  ) => Promise<PdsAnnotationRead | null>;
  extractUrlMetadata?: typeof extractUrlMetadataRecord;
  writeAnnotation?: typeof writeAnnotationRecord;
  upsertAnnotation?: typeof upsertAnnotationRecord;
}

/** Normalize a stored field to undefined when it carries no value. */
function presentField(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

/**
 * Merge freshly fetched metadata into an existing annotation record, filling
 * only missing fields so user content survives repair:
 *
 * - Missing or known-default (on YouTube subjects) title/description are
 *   replaced with the fetched value when the fetch produced a usable one.
 *   When it did not, a known default is cleared (omitted on the wire) instead
 *   of being preserved — an incomplete record stays retryable, never
 *   fabricated boilerplate.
 * - The note and an existing meaningful (non-empty, non-default) title/
 *   description are never overwritten.
 * - image/favicon are filled only when the existing annotation lacks them.
 * - The existing createdAt is preserved when the read supplied one (the local
 *   mirror does not store it); otherwise a fresh timestamp is stamped.
 *
 * With an existing record of null (no annotation yet) this produces the fully
 * fetched record, matching the pre-merge behavior. The record subject is always
 * the bookmark's URI (bookmarkUri), never the input URL, so the original
 * subject stays intact; subjectUrl is the actual bookmarked URL used only to
 * decide whether known YouTube defaults count as placeholders.
 */
export function mergePreviewAnnotation(
  existing: AnnotationRecord | null,
  fetched: UrlMetadata,
  bookmarkUri: string,
  subjectUrl: string,
  now = new Date().toISOString(),
): AnnotationRecord {
  if (!existing) {
    return {
      subject: bookmarkUri,
      title: presentField(fetched.title),
      description: presentField(fetched.description),
      favicon: presentField(fetched.favicon),
      image: presentField(fetched.image),
      createdAt: now,
    };
  }
  const isYouTubeSubject = parseYouTubeVideoUrl(subjectUrl) !== null;
  const existingTitle = presentField(existing.title);
  const existingDescription = presentField(existing.description);
  const titleIsPlaceholder = !existingTitle ||
    (isYouTubeSubject && isKnownDefaultYouTubeTitle(existingTitle));
  const descriptionIsPlaceholder = !existingDescription ||
    (isYouTubeSubject && isKnownDefaultYouTubeDescription(existingDescription));
  return {
    subject: bookmarkUri,
    note: presentField(existing.note),
    createdAt: existing.createdAt ?? now,
    // A missing or known-default field takes the fetched value when one
    // exists; with no usable replacement the placeholder is cleared rather
    // than preserved. Meaningful existing values are never touched.
    title: titleIsPlaceholder ? presentField(fetched.title) : existingTitle,
    description: descriptionIsPlaceholder
      ? presentField(fetched.description)
      : existingDescription,
    favicon: presentField(existing.favicon) ?? presentField(fetched.favicon),
    image: presentField(existing.image) ?? presentField(fetched.image),
  };
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
  const readExisting = deps.readAnnotation ?? readAnnotationFromPds;

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
    // Empty metadata (e.g. a recognized YouTube URL whose oEmbed or page
    // fetch failed) must be a retryable failure, never a persisted empty or
    // dummy annotation. Generic non-YouTube extraction always yields at least
    // a hostname title, so this only triggers for genuinely empty results.
    if (!isNonEmptyUrlMetadata(metadata)) {
      throw new Error("no usable metadata obtained");
    }
    if (await checkAnnotation(job.bookmarkUri)) {
      await markPreviewJobDone(job.bookmarkUri);
      stats.skippedExisting = 1;
      return stats;
    }
    // The merge base is the CURRENT annotation record read from the
    // authoritative PDS (authenticated session + rkey). A PDS 404 is the
    // authoritative "no annotation" answer; any other PDS read failure throws
    // and is retried — a stale mirror is never used as the merge base or to
    // overwrite after a PDS error. YouTube-default classification uses the
    // bookmarked subject URL, not the AT-URI.
    const pdsAnnotation = await readExisting(oauthSession, job.rkey);
    const annotation = mergePreviewAnnotation(
      pdsAnnotation?.value ?? null,
      metadata,
      job.bookmarkUri,
      job.subject,
    );

    // Pass the fetched PDS CID as putRecord's swapRecord: a concurrent edit
    // between our read and this write fails safely (InvalidSwap → retry) on
    // the next attempt instead of being silently overwritten.
    const result = await putAnnotation(oauthSession, job.rkey, annotation, {
      swapRecord: pdsAnnotation?.cid,
    });
    if (!result.ok) throw new Error("annotation write failed");

    // Mirror the write WITHOUT clearing the job: the worker decides completion
    // itself below. Clearing here would delete the job before the decision,
    // and the next tick would re-enqueue a fresh attempts=0 job whenever the
    // annotation is still incomplete (e.g. the watch page had no usable
    // description), looping external fetches and PDS writes forever.
    await mirrorAnnotation(
      {
        uri: result.uri ??
          `at://${job.did}/${ANNOTATION_COLLECTION}/${job.rkey}`,
        did: job.did,
        rkey: job.rkey,
        cid: result.cid ?? "",
        subject: job.bookmarkUri,
        title: annotation.title ?? null,
        description: annotation.description ?? null,
        favicon: annotation.favicon ?? null,
        image: annotation.image ?? null,
        note: annotation.note ?? null,
      },
      { clearPreviewJob: false },
    );

    // Completion decision AFTER the write: if the merged annotation now
    // satisfies the same YouTube completeness predicate (read back through
    // the mirror, which reflects this write), the job is done. If it is still
    // incomplete — no usable description — the available fields were persisted
    // once for this attempt and the job keeps its bounded retry/backoff
    // (three attempts) instead of being marked done and looping forever.
    if (await checkAnnotation(job.bookmarkUri)) {
      await markPreviewJobDone(job.bookmarkUri);
      stats.success = 1;
    } else {
      const status = await markPreviewJobRetry(
        job,
        new Error(
          "annotation incomplete after enrichment write (bounded retry)",
        ),
      );
      if (status === "failed") stats.stopped = 1;
      else stats.retry = 1;
    }
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
