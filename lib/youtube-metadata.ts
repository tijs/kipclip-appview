/**
 * YouTube-aware metadata resolution, narrowly scoped to recognized video URLs.
 *
 * Public-first-party metadata only: YouTube oEmbed (title/author/thumbnail)
 * followed by the canonical watch page for a real description when available.
 * No Data API key, no secrets, no arbitrary fetches.
 *
 * Safety invariants:
 * - Only allowlisted YouTube hosts are classified; every fetch URL is
 *   constructed from a validated 11-char video ID, never from user input.
 * - Redirects are not followed (`redirect: "manual"`), fetches are bounded by
 *   timeout and byte caps, and thumbnail URLs must come from i.ytimg.com.
 * - All failures surface as {@link YouTubeMetadataError} so callers can treat
 *   them as retryable instead of manufacturing placeholder metadata.
 */

import { decode } from "html-entities";

/** Error thrown whenever no useful YouTube metadata could be obtained. */
export class YouTubeMetadataError extends Error {}

/** A recognized YouTube video URL with its canonical watch URL. */
export interface YouTubeVideoRef {
  videoId: string;
  canonicalWatchUrl: string;
}

/** Metadata extracted from public YouTube endpoints (all validated). */
export interface YouTubeFetchedMetadata {
  title: string;
  author?: string;
  description?: string;
  thumbnailUrl?: string;
}

/** Known exporter/YouTube default titles that carry no information. */
export const KNOWN_DEFAULT_YOUTUBE_TITLES: readonly string[] = [
  "- YouTube",
  "YouTube",
];

/** Known generic YouTube descriptions that carry no information. */
export const KNOWN_DEFAULT_YOUTUBE_DESCRIPTIONS: readonly string[] = [
  "Share your videos with friends, family, and the world.",
  "Enjoy the videos and music you love, upload original content, " +
  "and share it all with friends, family, and the world on YouTube.",
  // Localized default annotations observed on live accounts (German 68 rows,
  // Dutch 1 row alongside the English default above). Exact boilerplate only:
  // no keyword heuristics, so real user descriptions can never be caught.
  "Auf YouTube findest du die angesagtesten Videos und Tracks. " +
  "Außerdem kannst du eigene Inhalte hochladen und mit Freunden " +
  "oder gleich der ganzen Welt teilen.",
  "Bekijk je favoriete video's, luister naar de muziek die je leuk " +
  "vindt, upload originele content en deel alles met vrienden, " +
  "familie en anderen op YouTube.",
];

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_URL_LENGTH = 2000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_IMAGE_URL_LENGTH = 2000;
const MAX_OEMBED_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const OEMBED_TIMEOUT_MS = 8000;
const PAGE_TIMEOUT_MS = 8000;

const USER_AGENT =
  "kipclip-bot/1.0 (Bookmark enrichment; +https://kipclip.com)";

/** Hosts that may be classified as YouTube video URLs. */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** Hosts allowed for thumbnail URLs returned by oEmbed. */
const THUMBNAIL_HOSTS = new Set(["i.ytimg.com", "img.youtube.com"]);

/** Collapse whitespace, trim, and lowercase for boilerplate comparison. */
export function normalizeComparable(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function isInDefaults(text: string, defaults: readonly string[]): boolean {
  const comparable = normalizeComparable(text);
  return defaults.some((d) => normalizeComparable(d) === comparable);
}

/** True when the title is a known exporter/YouTube default. */
export function isKnownDefaultYouTubeTitle(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return isInDefaults(text, KNOWN_DEFAULT_YOUTUBE_TITLES);
}

/** True when the description is a known generic YouTube default. */
export function isKnownDefaultYouTubeDescription(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return isInDefaults(text, KNOWN_DEFAULT_YOUTUBE_DESCRIPTIONS);
}

/**
 * Classify a URL as a YouTube video. Returns the validated video ID and the
 * canonical full watch URL used for metadata fetching, or null when the URL
 * is not a supported watch / youtu.be / shorts / live / embed video link.
 *
 * Never mutates the caller's URL — callers keep the original subject intact.
 */
export function parseYouTubeVideoUrl(
  urlString: string,
): YouTubeVideoRef | null {
  if (typeof urlString !== "string" || urlString.length === 0) return null;
  if (urlString.length > MAX_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let videoId: string | null = null;
  const path = url.pathname;

  if (host === "youtu.be") {
    const match = path.match(/^\/([^/]+)\/?$/);
    if (match) videoId = match[1];
  } else {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const first = segments[0].toLowerCase();
    if (first === "watch") {
      if (segments.length !== 1) return null;
      const v = url.searchParams.get("v");
      if (v) videoId = v;
    } else if (
      first === "shorts" || first === "live" || first === "embed" ||
      first === "v"
    ) {
      if (segments.length !== 2) return null;
      videoId = segments[1];
    } else {
      // channel / @handle / user / c / playlist / results / feed / …
      return null;
    }
  }

  if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;
  return {
    videoId,
    canonicalWatchUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

/**
 * Deterministic ID-based thumbnail fallback. Returns undefined unless the ID
 * is a valid 11-char YouTube video ID, so no broken URL is ever produced.
 */
export function deterministicYouTubeThumbnail(
  videoId: string,
): string | undefined {
  if (!VIDEO_ID_RE.test(videoId)) return undefined;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function sanitizeText(text: string, maxLength: number): string {
  // deno-lint-ignore no-control-regex
  const controlCharsRegex = /[\x00-\x1F\x7F]/g;
  return text
    .trim()
    .replace(controlCharsRegex, "")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

/**
 * Fetch a URL with a timeout and a hard byte cap, without following
 * redirects. Throws {@link YouTubeMetadataError} on any failure.
 *
 * Exported for focused tests; not part of the public API surface.
 */
export async function fetchBounded(
  fetcher: typeof fetch,
  url: string,
  timeoutMs: number,
  maxBytes: number,
  expectedContentType: string | null,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new YouTubeMetadataError(`HTTP ${response.status}`);
    }
    if (expectedContentType) {
      const contentType = response.headers.get("content-type") || "";
      // Only reject a *present* mismatching content-type. Some proxies (and
      // this runtime's Response.clone()) omit the header entirely; the parsed
      // payload and field validation below remain the real gate.
      if (
        contentType && !contentType.toLowerCase().includes(expectedContentType)
      ) {
        throw new YouTubeMetadataError(
          `unexpected content-type: ${contentType}`,
        );
      }
    }
    if (!response.body) {
      // A bodyless response carries no bounded stream to read. Honor a
      // declared Content-Length as a hard cap, and never fall back to
      // response.text(): a custom bodyless response could expose an
      // unbounded body that would bypass the byte cap (text() reads the
      // whole payload before any slice). Standard bodyless Responses read
      // as empty text anyway, so returning "" loses nothing.
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const length = Number(declaredLength);
        if (Number.isFinite(length) && length > maxBytes) {
          throw new YouTubeMetadataError("response too large");
        }
      }
      return "";
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let total = 0;
    let reachedCap = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        reachedCap = true;
        break;
      }
      if (value.byteLength > remaining) {
        // Slice the chunk down to the remaining budget BEFORE decoding so a
        // single oversized chunk can never blow past the byte cap in memory.
        total += remaining;
        result += decoder.decode(value.subarray(0, remaining), {
          stream: true,
        });
        reachedCap = true;
        break;
      }
      total += value.byteLength;
      result += decoder.decode(value, { stream: true });
      if (total >= maxBytes) {
        reachedCap = true;
        break;
      }
    }
    if (reachedCap) {
      await reader.cancel();
    }
    result += decoder.decode();
    return result;
  } catch (err) {
    if (err instanceof YouTubeMetadataError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new YouTubeMetadataError(message);
  } finally {
    // Always clear the abort timer — leaving it running after a successful
    // request leaked an 8-second timer (and a live AbortController) on every
    // fetch. On the timeout path the timer already fired; clearing is a no-op.
    clearTimeout(timeoutId);
  }
}

/**
 * Extract a bounded, sanitized description from a watch page. Returns
 * undefined when the page exposes no useful (non-generic) description.
 */
export function extractYouTubeDescription(html: string): string | undefined {
  const patterns: RegExp[] = [
    // meta name="description" (either attribute order). The backreference \1
    // honors the actual quote delimiter so apostrophes inside the value are
    // preserved instead of truncating at the first quote character.
    /<meta[^>]+name=["']description["'][^>]+content=(["'])(.*?)\1/i,
    /<meta[^>]+content=(["'])(.*?)\1[^>]+name=["']description["']/i,
    // og:description (either attribute order)
    /<meta[^>]+property=["']og:description["'][^>]+content=(["'])(.*?)\1/i,
    /<meta[^>]+content=(["'])(.*?)\1[^>]+property=["']og:description["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const raw = decode(match[2]);
    if (!raw.trim()) continue;
    const description = sanitizeText(raw, MAX_DESCRIPTION_LENGTH);
    if (isKnownDefaultYouTubeDescription(description)) return undefined;
    return description;
  }
  return undefined;
}

function validateOEmbedThumbnail(
  thumbnailUrl: unknown,
): string | undefined {
  if (typeof thumbnailUrl !== "string" || !thumbnailUrl) return undefined;
  try {
    const url = new URL(thumbnailUrl);
    const host = url.hostname.toLowerCase();
    if (!THUMBNAIL_HOSTS.has(host)) return undefined;
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    const href = url.href;
    return href.length <= MAX_IMAGE_URL_LENGTH ? href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve metadata for a recognized YouTube video:
 * 1. oEmbed for title/author/thumbnail (required — throws on any failure).
 * 2. Canonical watch page for a bounded description (optional — failures are
 *    logged but do not fail the oEmbed result).
 *
 * Throws {@link YouTubeMetadataError} when no useful metadata was obtained.
 */
export async function fetchYouTubeMetadata(
  ref: YouTubeVideoRef,
  fetcher: typeof fetch = fetch,
): Promise<YouTubeFetchedMetadata> {
  if (!VIDEO_ID_RE.test(ref.videoId)) {
    throw new YouTubeMetadataError("invalid video ID");
  }

  // 1. oEmbed (required)
  const oembedUrl = "https://www.youtube.com/oembed?format=json&url=" +
    encodeURIComponent(ref.canonicalWatchUrl);
  const oembedText = await fetchBounded(
    fetcher,
    oembedUrl,
    OEMBED_TIMEOUT_MS,
    MAX_OEMBED_BYTES,
    "application/json",
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(oembedText);
  } catch {
    throw new YouTubeMetadataError("invalid oEmbed JSON response");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new YouTubeMetadataError("invalid oEmbed response shape");
  }
  const { type, title, author_name, thumbnail_url } = parsed as Record<
    string,
    unknown
  >;
  if (type !== "video") {
    throw new YouTubeMetadataError(`unexpected oEmbed type: ${String(type)}`);
  }
  if (typeof title !== "string" || !title.trim()) {
    throw new YouTubeMetadataError("oEmbed title missing");
  }
  if (isKnownDefaultYouTubeTitle(title)) {
    throw new YouTubeMetadataError("oEmbed title is boilerplate");
  }
  const author = typeof author_name === "string" && author_name.trim()
    ? author_name.trim()
    : undefined;

  // 2. Watch-page description (optional)
  let description: string | undefined;
  try {
    const html = await fetchBounded(
      fetcher,
      ref.canonicalWatchUrl,
      PAGE_TIMEOUT_MS,
      MAX_PAGE_BYTES,
      "text/html",
    );
    description = extractYouTubeDescription(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[Enrichment] YouTube watch-page description unavailable for ` +
        `${ref.videoId}: ${message}`,
    );
  }

  return {
    title: sanitizeText(title, MAX_TITLE_LENGTH),
    author,
    description,
    thumbnailUrl: validateOEmbedThumbnail(thumbnail_url),
  };
}
