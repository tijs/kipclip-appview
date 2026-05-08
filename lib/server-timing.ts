/**
 * Server-Timing helper.
 *
 * Build a Server-Timing header by wrapping spans:
 *
 *   const t = createTimer();
 *   const x = await t.span("db", () => readBookmarks());
 *   const y = await t.span("supporter", () => isUserSupporter(s));
 *   return t.finalize(Response.json(payload));
 *
 * The header is visible in browser DevTools Network → Timing tab and parsed
 * by the frontend perf flush so we can correlate client + server time.
 *
 * Format: `Server-Timing: db;dur=12.3, supporter;dur=410.0, total;dur=425.1`
 *
 * Names must match the RFC 8941 token grammar — keep them short, lowercase,
 * alphanumeric + hyphens.
 */

interface Span {
  name: string;
  dur: number;
}

export interface Timer {
  /** Wrap an async function and record its duration under `name`. */
  span<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /** Record a duration without wrapping a function (manual mode). */
  add(name: string, durationMs: number): void;
  /** Attach the Server-Timing header to a response. */
  finalize(response: Response): Response;
  /** Read the current spans (for tests / logging). */
  spans(): readonly Span[];
}

const NAME_RE = /^[a-z0-9-]+$/;

function safeName(name: string): string {
  if (NAME_RE.test(name)) return name;
  // Strip non-token chars and trim leading/trailing hyphens so we can never
  // emit `Server-Timing: ;dur=…` (RFC 8941 violation; some browsers drop
  // the entire header).
  const cleaned = name.toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "span";
}

export function createTimer(): Timer {
  const spans: Span[] = [];
  const created = performance.now();

  async function span<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      spans.push({ name: safeName(name), dur: performance.now() - start });
    }
  }

  function add(name: string, durationMs: number): void {
    spans.push({ name: safeName(name), dur: durationMs });
  }

  function finalize(response: Response): Response {
    const total = performance.now() - created;
    const parts = spans
      .map((s) => `${s.name};dur=${s.dur.toFixed(1)}`)
      .concat([`total;dur=${total.toFixed(1)}`]);
    response.headers.set("Server-Timing", parts.join(", "));
    return response;
  }

  return { span, add, finalize, spans: () => spans };
}
