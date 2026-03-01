/**
 * PDS background migration registry.
 *
 * Migrations run fire-and-forget on page load (from /api/initial-data).
 * Each migration is caught independently so one failure doesn't block others.
 *
 * To add a new migration:
 * 1. Write a function matching the (ctx: PdsMigrationContext) => Promise<void> signature
 * 2. Add an entry to the `migrations` array below
 * 3. Document it in BACKGROUND-TASKS.md
 */

import type { AnnotationRecord } from "../shared/types.ts";
import { migrateAnnotations } from "./migration-annotations.ts";
import { repairMissingFavicons } from "./repair-favicons.ts";
import { mergeTagDuplicates } from "./migration-merge-tags.ts";

export interface PdsMigrationContext {
  oauthSession: any;
  bookmarkRecords: any[];
  tagRecords: any[];
  annotationMap: Map<string, AnnotationRecord>;
}

interface PdsMigration {
  name: string;
  run(ctx: PdsMigrationContext): Promise<void>;
}

const migrations: PdsMigration[] = [
  {
    name: "annotation-migration",
    run: (ctx) =>
      migrateAnnotations(
        ctx.oauthSession,
        ctx.bookmarkRecords,
        ctx.annotationMap,
      ),
  },
  {
    name: "favicon-repair",
    run: (ctx) =>
      repairMissingFavicons(
        ctx.oauthSession,
        ctx.bookmarkRecords,
        ctx.annotationMap,
      ),
  },
  {
    name: "tag-dedup",
    run: async (ctx) => {
      const result = await mergeTagDuplicates(
        ctx.oauthSession,
        ctx.tagRecords,
        ctx.bookmarkRecords,
      );
      if (result.merged > 0) {
        console.log(
          `Tag dedup: merged ${result.merged} groups, ` +
            `deleted ${result.tagsDeleted} tags, ` +
            `updated ${result.bookmarksUpdated} bookmarks`,
        );
      }
    },
  },
];

/**
 * Run all registered PDS background migrations.
 * Each migration catches its own errors so one failure doesn't block others.
 */
export async function runPdsMigrations(
  ctx: PdsMigrationContext,
): Promise<void> {
  for (const migration of migrations) {
    try {
      await migration.run(ctx);
    } catch (err) {
      console.error(`PDS migration "${migration.name}" error:`, err);
    }
  }
}
