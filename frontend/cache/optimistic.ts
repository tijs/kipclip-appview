/**
 * Optimistic mutation helper.
 * Updates React state + IndexedDB immediately, syncs to PDS in background.
 * Reverts on failure.
 */

const pendingMutations = new Set<string>();
let mutationCounter = 0;

export interface OptimisticOptions<T> {
  /** Unique key for this mutation (for dedup/tracking) */
  key?: string;
  /** Apply the change immediately (state + cache) */
  apply: () => T;
  /** Perform the actual remote operation */
  remote: () => Promise<void>;
  /** Revert the change if remote fails */
  revert: (snapshot: T) => void;
  /** Called on failure after revert */
  onError?: (error: Error) => void;
}

/**
 * Execute an optimistic mutation.
 * 1. apply() runs immediately — returns a snapshot for revert
 * 2. remote() runs in background
 * 3. On failure: revert(snapshot) undoes the change
 */
export function optimistic<T>(options: OptimisticOptions<T>): void {
  const key = options.key ?? `mutation-${++mutationCounter}`;

  const snapshot = options.apply();
  pendingMutations.add(key);

  options.remote()
    .catch((error: Error) => {
      options.revert(snapshot);
      options.onError?.(error);
    })
    .finally(() => {
      pendingMutations.delete(key);
    });
}

export function hasPendingMutations(): boolean {
  return pendingMutations.size > 0;
}
