/**
 * Public reviews source: kipclip's listing on atstore.fyi.
 *
 * Atstore exposes formal review records with ratings (1-5 stars),
 * text, and author identity. Higher signal than Bluesky posts that
 * happen to mention kipclip — these are reviews people deliberately
 * wrote on the app's directory page.
 *
 * Pipeline:
 *   1. Hit atstore reviews.listForListing for the kipclip listing URI.
 *   2. Filter out reviews authored by the project owner (would read
 *      as self-promotion if surfaced as social proof).
 *   3. Sort by rating desc, then by recency, take top N.
 *
 * `getReviews()` is the reusable entry point — re-importable from any
 * server module that wants to surface social proof.
 */

import {
  type CachedFetcher,
  createCachedFetcher,
  fetchWithTimeout,
} from "./cached-fetch.ts";

const ATSTORE_REVIEWS =
  "https://atstore.fyi/xrpc/fyi.atstore.reviews.listForListing";

// kipclip's listing URI on atstore. Stable per listing record; the
// rkey changes only if the listing is fully recreated. If atstore ever
// rotates the URI we'll surface zero reviews until this constant is
// updated.
const KIPCLIP_LISTING_URI =
  "at://did:plc:3zzkrrjtsmo7nnwnvhex3auj/fyi.atstore.listing.detail/3mkip5bumt2p5";

const OWNER_DIDS = new Set<string>([
  "did:plc:aq7owa5y7ndc2hzjz37wy7ma", // tijs.org
  "did:plc:3zzkrrjtsmo7nnwnvhex3auj", // kipclip atstore curator
]);

const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_LIMIT = 25;
const MAX_REVIEWS = 6;
const MIN_RATING = 4;

export interface Review {
  id: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  text: string;
  rating: number;
  createdAt: string;
  /** Permalink to the review on atstore.fyi (constructed client-side). */
  atstoreUrl: string;
}

interface AtstoreReview {
  id: string;
  authorDid: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatarUrl?: string;
  rating: number;
  text?: string;
  reviewCreatedAt: string;
}

interface AtstoreReviewsResponse {
  reviews?: AtstoreReview[];
}

function listingExternalUrl(): string {
  // Public-facing atstore page for a listing. Used as a permalink so
  // each review card can deep-link people to the directory entry.
  return "https://atstore.fyi/products/kipclip";
}

function toReview(raw: AtstoreReview): Review {
  return {
    id: raw.id,
    handle: raw.authorHandle,
    displayName: raw.authorDisplayName ?? raw.authorHandle,
    avatar: raw.authorAvatarUrl ?? null,
    text: raw.text ?? "",
    rating: raw.rating,
    createdAt: raw.reviewCreatedAt,
    atstoreUrl: listingExternalUrl(),
  };
}

async function fetchReviews(): Promise<Review[]> {
  const url = `${ATSTORE_REVIEWS}?uri=${
    encodeURIComponent(KIPCLIP_LISTING_URI)
  }&limit=${FETCH_LIMIT}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`atstore status ${res.status}`);
  }
  const body = await res.json() as AtstoreReviewsResponse;
  const raw = body.reviews ?? [];

  return raw
    .filter((r) => !OWNER_DIDS.has(r.authorDid))
    .filter((r) => r.rating >= MIN_RATING)
    .filter((r) => (r.text ?? "").trim().length > 0)
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      return new Date(b.reviewCreatedAt).getTime() -
        new Date(a.reviewCreatedAt).getTime();
    })
    .slice(0, MAX_REVIEWS)
    .map(toReview);
}

const fetcher: CachedFetcher<Review[]> = createCachedFetcher({
  ttlMs: TTL_MS,
  fetch: fetchReviews,
  fallback: [],
  label: "reviews",
});

export function getReviews(): Promise<{ data: Review[]; stale: boolean }> {
  return fetcher.get();
}
