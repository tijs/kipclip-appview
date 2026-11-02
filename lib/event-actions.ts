import type { AppEvent, EventType } from "./events.ts";

export interface EventAction {
  id: string;
  events: readonly EventType[];
  run(event: AppEvent): Promise<void>;
}

/** All background subscriptions live here. Producers publish facts and never
 * import an action. Adding a subscriber needs no changes to record sources. */
export const eventActions: readonly EventAction[] = [
  {
    id: "preview",
    events: ["bookmark.saved"],
    async run(event) {
      if (event.type !== "bookmark.saved") return;
      const { bookmark } = event;
      const { enqueueMissingPreviewJobsForDid } = await import(
        "./preview-enrichment-jobs.ts"
      );
      await enqueueMissingPreviewJobsForDid(bookmark.did, 1, {
        bookmarkUri: bookmark.uri,
      });
    },
  },
  {
    id: "instapaper",
    events: ["bookmark.saved"],
    async run(event) {
      if (event.type !== "bookmark.saved") return;
      const { deliverReadingListBookmark } = await import(
        "./instapaper-bookmark-action.ts"
      );
      await deliverReadingListBookmark(event);
    },
  },
  {
    id: "instapaper.reconcile",
    events: ["preferences.changed", "instapaper.connection.changed"],
    async run(event) {
      const { requeueEventActionForDid } = await import("./events.ts");
      await requeueEventActionForDid(event.did, "instapaper");
    },
  },
];

/** Bounded recovery/discovery sources use the same publication/subscriptions.
 * Keep domain-specific scanning out of the durable dispatcher. */
export const eventSources = [async (limit: number): Promise<number> => {
  const { backfillBookmarkEvents } = await import("./bookmark-events.ts");
  return await backfillBookmarkEvents(limit);
}];
