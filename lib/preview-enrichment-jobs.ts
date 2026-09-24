import type { AnnotationRecord } from "../shared/types.ts";
import { db } from "./db.ts";
import {
  isKnownDefaultYouTubeDescription,
  isKnownDefaultYouTubeTitle,
  KNOWN_DEFAULT_YOUTUBE_DESCRIPTIONS,
  KNOWN_DEFAULT_YOUTUBE_TITLES,
  normalizeComparable,
  parseYouTubeVideoUrl,
} from "./youtube-metadata.ts";

export type PreviewJobStatus =
  | "pending"
  | "done"
  | "failed"
  | "blocked_no_session";

export interface PreviewEnrichmentJob {
  bookmarkUri: string;
  did: string;
  rkey: string;
  subject: string;
  status: PreviewJobStatus;
  attempts: number;
  nextRunAt: number;
  lastError: string | null;
}

export interface MissingPreviewBookmark {
  uri: string;
  did: string;
  rkey: string;
  subject: string;
}

const DAY = 24 * 60 * 60 * 1000;

function rowToJob(row: unknown[]): PreviewEnrichmentJob {
  return {
    bookmarkUri: String(row[0]),
    did: String(row[1]),
    rkey: String(row[2]),
    subject: String(row[3]),
    status: row[4] as PreviewJobStatus,
    attempts: Number(row[5]),
    nextRunAt: Number(row[6]),
    lastError: row[7] === null ? null : String(row[7]),
  };
}

/**
 * SQLite-side mirror of {@link normalizeComparable} for a column expression:
 * C0 whitespace (tab/LF/VT/FF/CR) becomes a space, space runs are collapsed to
 * one space, then the result is trimmed and lowercased. Keeps the enqueue
 * query in agreement with the JS `isKnownDefaultYouTube*` checks for
 * lowercase/extra-whitespace variants of the known defaults.
 */
function normalizeColumnSql(column: string): string {
  let expr = column;
  for (const code of [9, 10, 11, 12, 13]) {
    expr = `REPLACE(${expr}, char(${code}), ' ')`;
  }
  // Each pass halves space runs; 6 passes collapse runs up to 64 long.
  for (let i = 0; i < 6; i++) {
    expr = `REPLACE(${expr}, '  ', ' ')`;
  }
  return `TRIM(LOWER(${expr}))`;
}

/** Subject expression, normalized the way the WHATWG URL parser trims input. */
const SUBJECT = "TRIM(LOWER(b.subject))";
/** Everything after the scheme (https:// → position 9, http:// → position 8). */
const AFTER_SCHEME =
  `substr(${SUBJECT}, CASE WHEN ${SUBJECT} LIKE 'https://%' THEN 9 ` +
  `WHEN ${SUBJECT} LIKE 'http://%' THEN 8 END)`;
/** Authority = host plus optional :port, up to the first '/'. */
const AUTHORITY = `CASE WHEN instr(${AFTER_SCHEME}, '/') > 0 THEN ` +
  `substr(${AFTER_SCHEME}, 1, instr(${AFTER_SCHEME}, '/') - 1) ` +
  `ELSE ${AFTER_SCHEME} END`;
/** Hostname = authority with a trailing :port stripped. */
const HOSTNAME = `CASE WHEN instr(${AUTHORITY}, ':') > 0 THEN ` +
  `substr(${AUTHORITY}, 1, instr(${AUTHORITY}, ':') - 1) ` +
  `ELSE ${AUTHORITY} END`;
/** Path + query + fragment, starting at the first '/'. */
const PATH_AND_QUERY = `CASE WHEN instr(${AFTER_SCHEME}, '/') > 0 THEN ` +
  `substr(${AFTER_SCHEME}, instr(${AFTER_SCHEME}, '/')) ELSE NULL END`;

/**
 * SQL condition for "this bookmark's subject looks like a recognized YouTube
 * video URL". Matches the URL shapes {@link parseYouTubeVideoUrl} accepts by
 * hostname equality instead of the old substring LIKE approximation:
 *
 * - http/https only; the authority's hostname must equal one of the
 *   allowlisted hosts. An explicit :port is stripped, so
 *   https://youtube.com:8443/watch?v=… is recognized, while
 *   music.youtube.com, evil.example/youtube.com/watch… and
 *   youtube.com.evil.example/watch… are NOT (hostname equality, no substrings).
 * - watch requires a v= query parameter; shorts/live/embed/v and youtu.be
 *   require exactly one path segment (tracking ?query/#fragment allowed).
 *
 * Still a structural approximation by design — it does not validate the
 * 11-char video ID, and a query string containing a '/' after a shorts/live/
 * embed/v ID is excluded (while JS accepts it). parseYouTubeVideoUrl remains
 * the final semantic gate for enrichment dispatch and usability decisions.
 */
const YOUTUBE_SUBJECT_SQL = `
  (
    (${SUBJECT} LIKE 'https://%' OR ${SUBJECT} LIKE 'http://%')
    AND ${HOSTNAME} IN (
      'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
      'youtube-nocookie.com', 'www.youtube-nocookie.com'
    )
    AND (
      (
        ${HOSTNAME} != 'youtu.be'
        AND (
          ${PATH_AND_QUERY} = '/watch'
          OR ${PATH_AND_QUERY} LIKE '/watch?%'
          OR ${PATH_AND_QUERY} LIKE '/watch#%'
        )
        AND instr(${PATH_AND_QUERY}, 'v=') > 0
      )
      OR (
        ${HOSTNAME} != 'youtu.be'
        AND (
          (${PATH_AND_QUERY} LIKE '/shorts/%'
            AND ${PATH_AND_QUERY} NOT LIKE '/shorts/%/%')
          OR (${PATH_AND_QUERY} LIKE '/live/%'
            AND ${PATH_AND_QUERY} NOT LIKE '/live/%/%')
          OR (${PATH_AND_QUERY} LIKE '/embed/%'
            AND ${PATH_AND_QUERY} NOT LIKE '/embed/%/%')
          OR (${PATH_AND_QUERY} LIKE '/v/%'
            AND ${PATH_AND_QUERY} NOT LIKE '/v/%/%')
        )
      )
      OR (
        ${HOSTNAME} = 'youtu.be'
        AND ${PATH_AND_QUERY} LIKE '/%'
        AND ${PATH_AND_QUERY} NOT LIKE '/%/%'
        AND ${PATH_AND_QUERY} != '/'
      )
    )
  )
`;

/**
 * SQL fragment for "the bookmark's annotation is incomplete and should be
 * re-enriched". Two branches:
 *
 * 1. Legacy placeholder-only (any subject): no note, image or favicon, and any
 *    title/description present is empty or a known exporter/YouTube default on
 *    an actual YouTube-video bookmark. Legacy placeholder-only annotations stay
 *    eligible for repair; a non-YouTube bookmark that happens to carry the
 *    literal string "YouTube" as title/description is meaningful and protected.
 * 2. YouTube partial preview: on a recognized YouTube-video subject, an
 *    annotation is incomplete when ANY preview field is missing/default —
 *    title, description, image or favicon — regardless of a user note or a
 *    meaningful title. A valid existing YouTube title alone must not prevent
 *    thumbnail/description enrichment, and a note alone must not protect an
 *    incomplete YouTube annotation (the worker merges fetched metadata without
 *    touching the note or meaningful user fields).
 *
 * Kept in agreement with {@link hasUsableAnnotation}: the SQL selects exactly
 * the annotations the worker's pre/post-fetch race checks consider not usable.
 */
function incompleteAnnotationConditionSql(): { sql: string; args: string[] } {
  const titleArgs = KNOWN_DEFAULT_YOUTUBE_TITLES.map((d) =>
    normalizeComparable(d)
  );
  const descriptionArgs = KNOWN_DEFAULT_YOUTUBE_DESCRIPTIONS.map((d) =>
    normalizeComparable(d)
  );
  const titlePlaceholders = titleArgs.map(() => "?").join(", ");
  const descriptionPlaceholders = descriptionArgs.map(() => "?").join(", ");
  return {
    sql: `
      (
        COALESCE(a.note, '') = ''
        AND COALESCE(a.image, '') = ''
        AND COALESCE(a.favicon, '') = ''
        AND (
          COALESCE(a.title, '') = ''
          OR (
            ${normalizeColumnSql("a.title")} IN (${titlePlaceholders})
            AND ${YOUTUBE_SUBJECT_SQL}
          )
        )
        AND (
          COALESCE(a.description, '') = ''
          OR (
            ${normalizeColumnSql("a.description")} IN (
              ${descriptionPlaceholders}
            )
            AND ${YOUTUBE_SUBJECT_SQL}
          )
        )
      )
      OR (
        ${YOUTUBE_SUBJECT_SQL}
        AND (
          COALESCE(a.title, '') = ''
          OR ${normalizeColumnSql("a.title")} IN (${titlePlaceholders})
          OR COALESCE(a.description, '') = ''
          OR ${normalizeColumnSql("a.description")} IN (
            ${descriptionPlaceholders}
          )
          OR COALESCE(a.image, '') = ''
          OR COALESCE(a.favicon, '') = ''
        )
      )
    `,
    args: [
      ...titleArgs,
      ...descriptionArgs,
      ...titleArgs,
      ...descriptionArgs,
    ],
  };
}

/**
 * Read the local mirror's annotation for a bookmark (keyed by subject = the
 * bookmark's URI). The mirror stores no record createdAt, so the returned
 * record carries only the fields the mirror persists (title, description,
 * favicon, image, note). Used by the preview worker as the merge base when
 * repairing an incomplete existing annotation; returns null when no annotation
 * exists yet.
 */
export async function readMirrorAnnotation(
  subject: string,
): Promise<AnnotationRecord | null> {
  const result = await db.execute({
    sql: `
      SELECT title, description, favicon, image, note
      FROM annotations
      WHERE subject = ?
      LIMIT 1
    `,
    args: [subject],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0] as [
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
  ];
  const annotation: AnnotationRecord = { subject };
  if (row[0] !== null && row[0] !== "") annotation.title = row[0];
  if (row[1] !== null && row[1] !== "") annotation.description = row[1];
  if (row[2] !== null && row[2] !== "") annotation.favicon = row[2];
  if (row[3] !== null && row[3] !== "") annotation.image = row[3];
  if (row[4] !== null && row[4] !== "") annotation.note = row[4];
  return annotation;
}

export async function findMissingPreviewBookmarks(
  did: string,
  limit = 25,
): Promise<MissingPreviewBookmark[]> {
  const incomplete = incompleteAnnotationConditionSql();
  const result = await db.execute({
    sql: `
      SELECT b.uri, b.did, b.rkey, b.subject
      FROM bookmarks b
      LEFT JOIN annotations a ON a.subject = b.uri AND a.did = b.did
      WHERE b.did = ?
        AND (
          a.uri IS NULL OR (${incomplete.sql})
        )
      ORDER BY b.created_at DESC
      LIMIT ?
    `,
    args: [did, ...incomplete.args, limit],
  });
  return result.rows.map((row) => ({
    uri: String(row[0]),
    did: String(row[1]),
    rkey: String(row[2]),
    subject: String(row[3]),
  }));
}

export interface EnqueuePreviewOptions {
  /** Explicit authenticated reactivation: reopen failed / blocked_no_session
   * jobs as a fresh pending attempt (attempts reset, immediate next run).
   * Periodic scans (default) must leave terminal jobs stable. */
  reactivate?: boolean;
}

/**
 * Enqueue missing bookmark previews and return the number of rows touched by
 * the upsert, including idempotent subject/rkey refreshes.
 */
export async function enqueueMissingPreviewJobsForDid(
  did: string,
  limit = 25,
  opts: EnqueuePreviewOptions = {},
): Promise<number> {
  const missing = await findMissingPreviewBookmarks(did, limit);
  let enqueued = 0;
  const now = Date.now();
  const reactivate = opts.reactivate ?? false;
  // Periodic scans (reactivate=false) insert new pending jobs and refresh
  // rkey/subject but never reopen terminal jobs (done/failed/blocked_no_session).
  // Explicit reactivation reopens failed and blocked_no_session jobs as a fresh
  // pending attempt: attempts reset to 0 and next_run_at scheduled immediately.
  const onConflict = reactivate
    ? `
        ON CONFLICT(bookmark_uri) DO UPDATE SET
          subject = excluded.subject,
          rkey = excluded.rkey,
          status = CASE
            WHEN preview_enrichment_jobs.status IN ('failed', 'blocked_no_session')
              THEN 'pending'
            ELSE preview_enrichment_jobs.status
          END,
          attempts = CASE
            WHEN preview_enrichment_jobs.status IN ('failed', 'blocked_no_session') THEN 0
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN 0
            ELSE preview_enrichment_jobs.attempts
          END,
          next_run_at = CASE
            WHEN preview_enrichment_jobs.status IN ('failed', 'blocked_no_session')
              THEN excluded.next_run_at
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN excluded.next_run_at
            ELSE preview_enrichment_jobs.next_run_at
          END,
          last_error = CASE
            WHEN preview_enrichment_jobs.status IN ('failed', 'blocked_no_session') THEN NULL
            ELSE preview_enrichment_jobs.last_error
          END,
          updated_at = excluded.updated_at
      `
    : `
        ON CONFLICT(bookmark_uri) DO UPDATE SET
          subject = excluded.subject,
          rkey = excluded.rkey,
          status = CASE
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN 'pending'
            ELSE preview_enrichment_jobs.status
          END,
          attempts = CASE
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN 0
            ELSE preview_enrichment_jobs.attempts
          END,
          next_run_at = CASE
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN excluded.next_run_at
            ELSE preview_enrichment_jobs.next_run_at
          END,
          last_error = CASE
            WHEN preview_enrichment_jobs.subject != excluded.subject THEN NULL
            ELSE preview_enrichment_jobs.last_error
          END,
          updated_at = excluded.updated_at
      `;
  for (const bookmark of missing) {
    const result = await db.execute({
      sql: `
        INSERT INTO preview_enrichment_jobs (
          bookmark_uri, did, rkey, subject, status, attempts,
          next_run_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)
        ${onConflict}
      `,
      args: [
        bookmark.uri,
        bookmark.did,
        bookmark.rkey,
        bookmark.subject,
        now,
        now,
        now,
      ],
    });
    if (result.rowsAffected > 0) enqueued++;
  }
  return enqueued;
}

export async function listPreviewEnrichmentSessionDids(
  limit = 10,
  offset = 0,
  now = Date.now(),
): Promise<string[]> {
  const result = await db.execute({
    sql: `
      SELECT DISTINCT b.did
      FROM bookmarks b
      JOIN iron_session_storage s ON s.key = 'session:' || b.did
      WHERE s.expires_at IS NULL OR s.expires_at > ?
      ORDER BY b.did
      LIMIT ? OFFSET ?
    `,
    args: [now, limit, offset],
  });
  return result.rows.map((row) => String(row[0]));
}

export async function enqueueMissingPreviewJobsForSessionDids(
  didLimit = 10,
  perDidLimit = 25,
  offset = 0,
): Promise<{ enqueued: number; dids: number }> {
  const dids = await listPreviewEnrichmentSessionDids(didLimit, offset);
  let enqueued = 0;
  for (const did of dids) {
    enqueued += await enqueueMissingPreviewJobsForDid(did, perDidLimit);
  }
  return { enqueued, dids: dids.length };
}

export async function claimPreviewEnrichmentJobs(
  limit = 5,
  now = Date.now(),
): Promise<PreviewEnrichmentJob[]> {
  const result = await db.execute({
    sql: `
      SELECT bookmark_uri, did, rkey, subject, status, attempts,
             next_run_at, last_error
      FROM preview_enrichment_jobs
      WHERE status = 'pending' AND next_run_at <= ?
      ORDER BY next_run_at ASC, created_at ASC
      LIMIT ?
    `,
    args: [now, limit],
  });
  return result.rows.map(rowToJob);
}

export async function markPreviewJobDone(bookmarkUri: string): Promise<void> {
  await db.execute({
    sql: `
      UPDATE preview_enrichment_jobs
      SET status = 'done', last_error = NULL, updated_at = ?
      WHERE bookmark_uri = ?
    `,
    args: [Date.now(), bookmarkUri],
  });
}

export async function markPreviewJobBlockedNoSession(
  job: PreviewEnrichmentJob,
  now = Date.now(),
): Promise<void> {
  await db.execute({
    sql: `
      UPDATE preview_enrichment_jobs
      SET status = 'blocked_no_session', last_error = ?, updated_at = ?
      WHERE bookmark_uri = ?
    `,
    args: ["no usable OAuth session", now, job.bookmarkUri],
  });
}

export async function markPreviewJobRetry(
  job: PreviewEnrichmentJob,
  error: unknown,
  now = Date.now(),
): Promise<"pending" | "failed"> {
  const attempts = job.attempts + 1;
  const stopped = attempts >= 3;
  const nextRunAt = attempts === 1 ? now + DAY : now + 7 * DAY;
  const message = error instanceof Error ? error.message : String(error);
  await db.execute({
    sql: `
      UPDATE preview_enrichment_jobs
      SET status = ?, attempts = ?, next_run_at = ?, last_error = ?, updated_at = ?
      WHERE bookmark_uri = ?
    `,
    args: [
      stopped ? "failed" : "pending",
      attempts,
      stopped ? now : nextRunAt,
      message.slice(0, 500),
      now,
      job.bookmarkUri,
    ],
  });
  return stopped ? "failed" : "pending";
}

/**
 * True when the annotation needs no further enrichment, mirroring the SQL
 * discovery predicate in {@link incompleteAnnotationConditionSql}:
 *
 * - On a recognized YouTube-video subject the annotation is usable (complete)
 *   only when every preview field is present and non-default: title,
 *   description, image AND favicon. A valid title alone (or a user note with
 *   still-missing preview fields) must NOT be marked usable — the worker must
 *   attempt thumbnail/description enrichment and merge without overwriting the
 *   note or meaningful user fields.
 * - For non-YouTube subjects the existing behavior is preserved: any note,
 *   image, favicon, or non-empty title/description makes the annotation
 *   usable, and an annotation is only selected when it is placeholder-only.
 *
 * The worker's pre-fetch and post-fetch race checks both use this predicate,
 * so a fully enriched annotation is never re-written and an annotation that
 * becomes complete mid-flight is skipped.
 */
export async function hasUsableAnnotation(
  bookmarkUri: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `
      SELECT COALESCE(a.note, ''), COALESCE(a.title, ''), COALESCE(a.description, ''),
             COALESCE(a.image, ''), COALESCE(a.favicon, ''), COALESCE(b.subject, '')
      FROM annotations a
      LEFT JOIN bookmarks b ON b.uri = a.subject
      WHERE a.subject = ?
      LIMIT 1
    `,
    args: [bookmarkUri],
  });
  if (result.rows.length === 0) return false;
  const [note, title, description, image, favicon, subject] = result
    .rows[0] as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
  const isYouTubeSubject = parseYouTubeVideoUrl(subject) !== null;
  if (isYouTubeSubject) {
    return title !== "" && !isKnownDefaultYouTubeTitle(title) &&
      description !== "" &&
      !isKnownDefaultYouTubeDescription(description) &&
      image !== "" && favicon !== "";
  }
  if (note !== "" || image !== "" || favicon !== "") return true;
  // Known exporter/YouTube defaults only count as placeholders when the
  // bookmarked URL is actually a YouTube video. A non-YouTube bookmark whose
  // title is exactly "YouTube" (e.g. a Wikipedia article about YouTube) is
  // meaningful and must be protected from re-enrichment.
  if (title !== "" || description !== "") return true;
  return false;
}

function trimmedField(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/**
 * Record-level twin of {@link hasUsableAnnotation}: decide whether an
 * annotation RECORD (e.g. a TAP webhook echo) is complete/usable WITHOUT
 * consulting the mirror. The webhook uses it to keep the preview retry
 * machinery intact: a COMPLETE annotation echo still settles/cancels queued
 * preview work (default clearPreviewJob), while an INCOMPLETE echo — e.g. the
 * preview worker's own bounded-retry write when a YouTube watch page had no
 * usable description — must not delete the pending/failed retry job and its
 * attempts/backoff, or the next scan re-enqueues an attempts=0 job forever.
 *
 * Mirrors {@link hasUsableAnnotation} exactly: on a recognized YouTube video
 * subject every preview field (title, description, image, favicon) must be
 * present and non-default; any other subject is usable when note/image/favicon
 * or a meaningful (non-empty) title/description is present. subjectUrl is the
 * bookmarked URL (bookmarks.subject), used only for the YouTube
 * classification; null behaves like a non-YouTube subject. Judging from the
 * record itself stays order-independent of mirror writes.
 */
export function isUsableAnnotationRecord(
  fields: {
    subjectUrl: string | null;
    title?: string | null;
    description?: string | null;
    image?: string | null;
    favicon?: string | null;
    note?: string | null;
  },
): boolean {
  const title = trimmedField(fields.title);
  const description = trimmedField(fields.description);
  const note = trimmedField(fields.note);
  const image = trimmedField(fields.image);
  const favicon = trimmedField(fields.favicon);
  const isYouTubeSubject = fields.subjectUrl !== null &&
    parseYouTubeVideoUrl(fields.subjectUrl) !== null;
  if (isYouTubeSubject) {
    return title !== "" && !isKnownDefaultYouTubeTitle(title) &&
      description !== "" &&
      !isKnownDefaultYouTubeDescription(description) &&
      image !== "" && favicon !== "";
  }
  return note !== "" || image !== "" || favicon !== "" ||
    title !== "" || description !== "";
}
