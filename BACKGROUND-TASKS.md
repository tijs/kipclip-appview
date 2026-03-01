# Background Tasks

Background PDS migrations run fire-and-forget during `/api/initial-data` (page
load). These are temporary — each should be removed once it's no longer needed.

All migrations are registered in `lib/pds-migrations.ts`. To add a new one:

1. Write a function that accepts `PdsMigrationContext`
2. Add an entry to the `migrations` array in `lib/pds-migrations.ts`
3. Document it below

Each migration catches its own errors so one failure doesn't block others.

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

## 3. Tag Dedup (`lib/migration-merge-tags.ts`)

**Added:** 2026-03-01 (case-insensitive tag deduplication)

Merges duplicate tags that differ only in casing (e.g., "Recipe" and "recipe").
Keeps the earliest-created tag as canonical, updates bookmarks to use the
canonical casing, and deletes the duplicate tag records.

Also available as a manual endpoint via `POST /api/tags/merge-duplicates`
(triggered from Settings UI).

**When to remove:** Once all active users have loaded the app at least once
after this migration deployed. The migration is a no-op when no duplicate tags
exist.
