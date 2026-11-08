/** Serialize work while retaining a trailing request made during an active run.
 * All callers wait for the resulting state, including the trailing run. */
export function createTrailingTask<T>(run: () => Promise<T>): () => Promise<T> {
  let active: Promise<T> | undefined;
  let dirty = false;
  return () => {
    dirty = true;
    if (!active) {
      active = Promise.resolve().then(async () => {
        try {
          let result: T;
          do {
            dirty = false;
            try {
              result = await run();
            } catch (error) {
              if (!dirty) throw error;
            }
          } while (dirty);
          return result!;
        } finally {
          // Clear in the same continuation as the final dirty check. A chained
          // finally leaves a microtask gap where a new request can be lost.
          active = undefined;
        }
      });
    }
    return active;
  };
}
