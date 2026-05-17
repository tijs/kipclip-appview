/**
 * Public supporters source: people who have made a kipclip support
 * record on atprotofans.com. Atprotofans gives us the DID list; we
 * hydrate handle / displayName / avatar through the Bluesky public app
 * view so avatars stay current even when a supporter changes theirs.
 */

import { KIPCLIP_DID } from "./atprotofans.ts";
import {
  type CachedFetcher,
  createCachedFetcher,
  fetchWithTimeout,
} from "./cached-fetch.ts";

const ATPROTOFANS_GET_SUPPORTERS =
  "https://atprotofans.com/xrpc/com.atprotofans.getSupporters";
const APPVIEW_GET_PROFILES =
  "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SUPPORTERS = 25;

// DIDs that show up as "supporters" administratively (the project
// owner, the kipclip account itself) but shouldn't be displayed as
// public social proof.
const HIDDEN_DIDS = new Set<string>([
  KIPCLIP_DID,
  "did:plc:aq7owa5y7ndc2hzjz37wy7ma", // tijs.org
]);

export interface Supporter {
  did: string;
  handle: string;
  displayName: string;
  avatar: string | null;
}

export interface SupportersPayload {
  supporters: Supporter[];
  /** Total returned by atprotofans (pre-filter, pre-truncation). */
  totalCount: number;
}

interface AtprotoFansSupporter {
  did: string;
  handle: string;
  displayName?: string;
}

interface AtprotoFansResponse {
  supporters?: AtprotoFansSupporter[];
}

interface BskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

async function fetchSupporters(): Promise<SupportersPayload> {
  const url = `${ATPROTOFANS_GET_SUPPORTERS}?subject=${
    encodeURIComponent(KIPCLIP_DID)
  }&limit=${MAX_SUPPORTERS}`;

  const fansRes = await fetchWithTimeout(url);
  if (!fansRes.ok) {
    throw new Error(`atprotofans status ${fansRes.status}`);
  }
  const fans = await fansRes.json() as AtprotoFansResponse;
  const raw = fans.supporters ?? [];
  const totalCount = raw.length;

  const visible = raw.filter((s) => !HIDDEN_DIDS.has(s.did));
  if (visible.length === 0) {
    return { supporters: [], totalCount };
  }

  const params = new URLSearchParams();
  for (const s of visible) params.append("actors", s.did);

  const profilesRes = await fetchWithTimeout(
    `${APPVIEW_GET_PROFILES}?${params.toString()}`,
  );
  if (!profilesRes.ok) {
    throw new Error(`appview status ${profilesRes.status}`);
  }
  const profiles =
    (await profilesRes.json() as { profiles?: BskyProfile[] }).profiles ?? [];
  const byDid = new Map(profiles.map((p) => [p.did, p]));

  const supporters: Supporter[] = visible.map((s) => {
    const profile = byDid.get(s.did);
    return {
      did: s.did,
      handle: profile?.handle ?? s.handle,
      displayName: profile?.displayName ?? s.displayName ?? s.handle,
      avatar: profile?.avatar ?? null,
    };
  });

  return { supporters, totalCount };
}

const fetcher: CachedFetcher<SupportersPayload> = createCachedFetcher({
  ttlMs: TTL_MS,
  fetch: fetchSupporters,
  fallback: { supporters: [], totalCount: 0 },
  label: "supporters",
});

export function getSupporters(): Promise<
  { data: SupportersPayload; stale: boolean }
> {
  return fetcher.get();
}
