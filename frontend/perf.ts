/**
 * Lightweight performance instrumentation using the Performance API.
 * Stores timings in window.__kipclipPerf for console access and ships a
 * single bundle to /api/metrics via navigator.sendBeacon at end-of-load.
 *
 * Manual usage:
 *   perf.start("cacheRead");
 *   // ... do work ...
 *   perf.end("cacheRead");
 *
 * Inspect in console:  __kipclipPerf.report()
 *
 * Web Vitals (LCP, FCP, TTFB, INP) are collected automatically via
 * PerformanceObserver and merged into the beacon. Server-Timing values from
 * /api/initial-data and /api/tags are read off the resource timing entries.
 */

interface PerfEntry {
  start: number;
  end?: number;
  duration?: number;
}

const entries = new Map<string, PerfEntry>();
const vitals: Record<string, number> = {};
let flushed = false;

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

  /** Record a one-shot value (no start/end). Useful for counts and vitals. */
  record(label: string, value: number): void {
    entries.set(label, { start: 0, end: value, duration: value });
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

  vitals(): Record<string, number> {
    return { ...vitals };
  },

  /**
   * Ship the current perf bundle to /api/metrics via sendBeacon.
   *
   * Idempotent: only fires once per page load unless `force=true`. The
   * load-time flush from `loadInitialData` is the no-force call; the
   * `pagehide` listener at the bottom of this module passes `force=true`
   * to capture late LCP/INP that arrived after the initial flush.
   *
   * Note: this means subsequent `refreshData` cycles do NOT emit a fresh
   * beacon, since they share the same page lifecycle. If we ever want
   * per-refresh perf tracking, route refresh metrics through a separate
   * endpoint or pass `force=true` from the refresh path.
   */
  flush(
    meta: {
      bookmarks?: number;
      pagesLoaded?: number;
      release?: string;
      visibility?: "load" | "pagehide";
    } = {},
    force = false,
  ): void {
    if (flushed && !force) return;
    flushed = true;
    try {
      const body = JSON.stringify({
        entries: perf.report(),
        vitals: { ...vitals },
        serverTiming: collectServerTiming(),
        bookmarks: meta.bookmarks,
        pagesLoaded: meta.pagesLoaded,
        release: meta.release,
        visibility: meta.visibility ?? "load",
      });
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/metrics", blob);
      } else {
        fetch("/api/metrics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch (err) {
      console.warn("[perf] flush failed", err);
    }
  },
};

/**
 * Walk recent /api/* resource entries and pull Server-Timing values.
 * Same-origin requests expose serverTiming directly (no TAO needed).
 * Returned keys prefixed with the route (e.g. `initial-data.session`).
 */
function collectServerTiming(): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof PerformanceObserver === "undefined") return out;
  const resources = performance.getEntriesByType(
    "resource",
  ) as PerformanceResourceTiming[];
  for (const r of resources) {
    if (!r.name.includes("/api/")) continue;
    const st = (r as any).serverTiming as
      | { name: string; duration: number }[]
      | undefined;
    if (!st) continue;
    const route = r.name.split("/api/")[1]?.split("?")[0]?.split("/")[0];
    if (!route) continue;
    for (const s of st) {
      const key = `${route}.${s.name}`;
      const prev = out[key];
      out[key] = prev ? Math.max(prev, s.duration) : s.duration;
    }
  }
  return out;
}

/** Wire up automatic vitals collection. Safe to call multiple times. */
function initVitals(): void {
  if (typeof PerformanceObserver === "undefined") return;

  // Largest Contentful Paint (latest entry wins).
  try {
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) vitals.lcp = Math.round(last.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* not supported */ }

  // First Contentful Paint.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") {
          vitals.fcp = Math.round(entry.startTime);
        }
      }
    }).observe({ type: "paint", buffered: true });
  } catch { /* not supported */ }

  // TTFB from navigation timing.
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav) vitals.ttfb = Math.round(nav.responseStart);
  } catch { /* not supported */ }

  // Cumulative Layout Shift.
  let clsValue = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (!entry.hadRecentInput) clsValue += entry.value;
      }
      vitals.cls = Math.round(clsValue * 1000) / 1000;
    }).observe({ type: "layout-shift", buffered: true });
  } catch { /* not supported */ }

  // INP via event timing — track the worst event.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = (entry as any).duration ?? 0;
        if (dur > (vitals.inp ?? 0)) vitals.inp = Math.round(dur);
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as any);
  } catch { /* not supported */ }
}

if (typeof globalThis !== "undefined") {
  (globalThis as any).__kipclipPerf = perf;
  if (typeof document !== "undefined") {
    initVitals();
    // Best-effort flush on page hide so we capture INP/LCP that arrived
    // after our explicit load-time flush.
    globalThis.addEventListener("pagehide", () => {
      perf.flush({ visibility: "pagehide" }, true);
    });
  }
}
