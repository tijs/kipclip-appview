/**
 * Shared URL utilities for duplicate detection.
 * Works in both Deno (backend) and browser (frontend).
 */

/**
 * Well-known ad/click tracking identifiers from the major platforms. These tag
 * the referral or ad click, never the content, so a URL serves the same page
 * regardless of their value. Matched exactly (case-insensitive). Kept
 * deliberately conservative — only params that are unambiguously
 * content-invariant across the whole web.
 */
const TRACKING_PARAMS = new Set([
  "fbclid", // Facebook
  "gclid", // Google Ads
  "gbraid", // Google Ads (iOS)
  "wbraid", // Google Ads (iOS)
  "dclid", // Google Display / DoubleClick
  "msclkid", // Microsoft / Bing Ads
  "ttclid", // TikTok
  "twclid", // X / Twitter
  "yclid", // Yandex
  "igshid", // Instagram
]);

/**
 * True for tracking/analytics parameters that should be ignored when matching
 * URLs for duplicate detection. Two shapes:
 *
 *  - UTM parameters, matched by the `utm_` prefix (utm_source, utm_medium,
 *    utm_campaign, utm_term, utm_content, utm_id, …).
 *  - Well-known ad/click identifiers (see TRACKING_PARAMS above).
 *
 * These are analytics-only — by design the server returns the same content
 * regardless of their values — so two URLs that differ only in tracking params
 * point at the same bookmark. Any other query parameter (?page=2, ?id=42,
 * ?v=...) can change the content and is treated as significant.
 */
function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || TRACKING_PARAMS.has(k);
}

/**
 * Normalize a URL for duplicate detection.
 *
 * Strips the fragment and any UTM tracking parameters, then sorts the
 * remaining query parameters so ordering differences don't defeat matching.
 * Meaningful query parameters are preserved: two URLs that differ in those
 * point at different content and are NOT duplicates.
 *
 * Returns null for invalid URLs.
 */
export function normalizeUrlForMatching(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    url.hash = "";

    const params = url.searchParams;
    for (const key of [...params.keys()]) {
      if (isTrackingParam(key)) params.delete(key);
    }
    params.sort();

    return url.toString();
  } catch {
    return null;
  }
}
