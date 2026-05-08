/**
 * Frontend perf beacon endpoint.
 *
 * The frontend ships one bundle per page load (and on pagehide) via
 * navigator.sendBeacon. We log it as a single structured JSON line so
 * journalctl on the box catches it and any future log shipper can scrape it
 * without code changes here.
 *
 * No auth: perf data has no security value and beacons fire before/around
 * session establishment. Size is capped, body is JSON-validated, and IP is
 * not logged (privacy + log volume).
 *
 * Sample line (single line in production logs):
 *   [perf] {"kind":"perf","ua":"...","entries":{"loadInitialData":312},
 *           "vitals":{"lcp":820,"fcp":410,"ttfb":120},"bookmarks":47}
 */

import type { App } from "@fresh/core";

const MAX_BEACON_BYTES = 4 * 1024;

interface Beacon {
  entries?: Record<string, number>;
  vitals?: Record<string, number>;
  bookmarks?: number;
  pagesLoaded?: number;
  serverTiming?: Record<string, number>;
  release?: string;
  visibility?: "load" | "pagehide";
}

function isFiniteNonNegative(v: unknown): v is number {
  // Reject NaN/Infinity AND negatives so a hostile client can't skew
  // dashboard percentiles by posting `lcp: -9999999`.
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function pruneNumeric(
  input: unknown,
  maxKeys: number,
): Record<string, number> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, number> = {};
  let count = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (count >= maxKeys) break;
    if (typeof k !== "string" || k.length > 40) continue;
    if (!isFiniteNonNegative(v)) continue;
    out[k] = Math.round(v * 10) / 10;
    count++;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseBeacon(raw: string): Beacon | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const beacon: Beacon = {};
  beacon.entries = pruneNumeric(obj.entries, 30);
  beacon.vitals = pruneNumeric(obj.vitals, 10);
  beacon.serverTiming = pruneNumeric(obj.serverTiming, 20);
  if (isFiniteNonNegative(obj.bookmarks)) beacon.bookmarks = obj.bookmarks;
  if (isFiniteNonNegative(obj.pagesLoaded)) {
    beacon.pagesLoaded = obj.pagesLoaded;
  }
  if (typeof obj.release === "string" && obj.release.length <= 40) {
    beacon.release = obj.release;
  }
  if (obj.visibility === "load" || obj.visibility === "pagehide") {
    beacon.visibility = obj.visibility;
  }
  return beacon;
}

/**
 * Read the request body up to `limit` bytes. Aborts as soon as the running
 * total exceeds the cap so a hostile chunked-transfer client can't make us
 * buffer arbitrary memory before we reject. Returns null on overflow.
 */
async function readBodyCapped(
  req: Request,
  limit: number,
): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    reader.releaseLock();
  }
}

export function registerMetricsRoutes(app: App<any>): App<any> {
  return app.post("/api/metrics", async (ctx) => {
    // content-length lets us reject oversized payloads without reading the
    // body. Chunked requests omit the header, so we still need the streamed
    // cap below to bound memory for those.
    const contentLength = Number(ctx.req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BEACON_BYTES) {
      return new Response(null, { status: 413 });
    }
    const body = await readBodyCapped(ctx.req, MAX_BEACON_BYTES).catch(() =>
      null
    );
    if (body === null) return new Response(null, { status: 413 });
    const beacon = parseBeacon(body);
    if (!beacon) return new Response(null, { status: 400 });

    const ua = ctx.req.headers.get("user-agent") ?? "";
    const line = JSON.stringify({
      kind: "perf",
      visibility: beacon.visibility ?? "load",
      release: beacon.release,
      bookmarks: beacon.bookmarks,
      pagesLoaded: beacon.pagesLoaded,
      entries: beacon.entries,
      vitals: beacon.vitals,
      serverTiming: beacon.serverTiming,
      ua: ua.slice(0, 120),
    });
    console.log("[perf]", line);

    // sendBeacon expects 2xx; 204 keeps the response empty + cheap.
    return new Response(null, { status: 204 });
  });
}
