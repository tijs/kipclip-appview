/**
 * Lightweight performance instrumentation using the Performance API.
 * Stores timings in window.__kipclipPerf for console access.
 *
 * Usage:
 *   perf.start("cacheRead");
 *   // ... do work ...
 *   perf.end("cacheRead");
 *   // In console: __kipclipPerf.report()
 */

interface PerfEntry {
  start: number;
  end?: number;
  duration?: number;
}

const entries = new Map<string, PerfEntry>();

export const perf = {
  start(label: string): void {
    entries.set(label, { start: performance.now() });
  },

  end(label: string): number {
    const entry = entries.get(label);
    if (!entry) return 0;
    entry.end = performance.now();
    entry.duration = entry.end - entry.start;
    return entry.duration;
  },

  report(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [label, entry] of entries) {
      result[label] = Math.round(
        entry.duration ?? performance.now() - entry.start,
      );
    }
    return result;
  },
};

// Expose on window for console access
if (typeof globalThis !== "undefined") {
  (globalThis as any).__kipclipPerf = perf;
}
