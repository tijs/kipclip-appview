# Background Tasks

Background tasks that run fire-and-forget during `/api/initial-data` (page
load). These are temporary — each should be removed once it's no longer needed.

## 1. Annotation Migration (`lib/migration-annotations.ts`)

**Added:** 2026-02-21 (annotation sidecar migration)

Moves enrichment data (`$enriched`, top-level `title`) from bookmark records to
annotation sidecar records (`com.kipclip.annotation`). Also cleans the bookmark
record afterward.

**When to remove:** Once all active users have loaded the app at least once
after the migration landed. At that point every bookmark will have its
enrichment in an annotation sidecar and the `$enriched` / top-level `title`
fields will be gone from bookmark records.

## 2. Favicon Repair (`lib/repair-favicons.ts`)

**Added:** 2026-02-22 (fix for favicon loss on edit)

Re-enriches annotations that are missing favicons. A bug in the bookmark update
handler read enrichment from `$enriched` (legacy) instead of the existing
annotation, so edits would overwrite the annotation with `favicon: undefined`.
The root cause was fixed in commit 678c36a.

**When to remove:** Once all active users have loaded the app at least once
after this fix deployed. The repair is a no-op when no annotations are missing
favicons.
