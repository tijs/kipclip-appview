/**
 * Public mentions source: Bluesky posts that link to kipclip.com,
 * discovered via Microcosm Constellation and hydrated through Bluesky's
 * public app view.
 *
 * Mentions != reviews. Reviews are formal review records on atstore.fyi
 * (see lib/reviews.ts). Mentions are organic Bluesky posts that
 * happened to link to the kipclip domain — looser signal, but
 * complements reviews by showing ongoing community interest.
 */

import {
  type CachedFetcher,
  createCachedFetcher,
  fetchWithTimeout,
} from "./cached-fetch.ts";

const TARGET_URL = "https://kipclip.com";
const CONSTELLATION = "https://constellation.microcosm.blue/links" +
  "?target=" + encodeURIComponent(TARGET_URL) +
  "&collection=app.bsky.feed.post" +
  "&path=" +
  encodeURIComponent(".facets[].features[app.bsky.richtext.facet#link].uri") +
  "&limit=25";
const APPVIEW_GET_POSTS =
  "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts";

const OWNER_DIDS = new Set<string>([
  "did:plc:aq7owa5y7ndc2hzjz37wy7ma", // tijs.org
  "did:plc:3zzkrrjtsmo7nnwnvhex3auj", // kipclip atstore curator
]);

const TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TEXT_LEN = 40;
const MAX_MENTIONS = 6;

export interface Mention {
  uri: string;
  cid: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  text: string;
  indexedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
}

interface ConstellationLink {
  did: string;
  collection: string;
  rkey: string;
}

interface ConstellationResponse {
  total?: number;
  linking_records?: ConstellationLink[];
}

interface BskyPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  record: {
    text?: string;
    reply?: unknown;
    createdAt?: string;
  };
  indexedAt: string;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
}

function buildAtUri(link: ConstellationLink): string {
  return `at://${link.did}/${link.collection}/${link.rkey}`;
}

function isMention(post: BskyPost): boolean {
  if (OWNER_DIDS.has(post.author.did)) return false;
  if (post.record.reply) return false;
  const text = post.record.text ?? "";
  if (text.length < MIN_TEXT_LEN) return false;
  return true;
}

function toMention(post: BskyPost): Mention {
  return {
    uri: post.uri,
    cid: post.cid,
    handle: post.author.handle,
    displayName: post.author.displayName ?? post.author.handle,
    avatar: post.author.avatar ?? null,
    text: post.record.text ?? "",
    indexedAt: post.indexedAt,
    likeCount: post.likeCount ?? 0,
    replyCount: post.replyCount ?? 0,
    repostCount: post.repostCount ?? 0,
  };
}

async function fetchMentions(): Promise<Mention[]> {
  const constellationRes = await fetchWithTimeout(CONSTELLATION);
  if (!constellationRes.ok) {
    throw new Error(`constellation status ${constellationRes.status}`);
  }
  const constellation = await constellationRes.json() as ConstellationResponse;
  const links = constellation.linking_records ?? [];
  if (links.length === 0) return [];

  const params = new URLSearchParams();
  for (const link of links) params.append("uris", buildAtUri(link));

  const postsRes = await fetchWithTimeout(
    `${APPVIEW_GET_POSTS}?${params.toString()}`,
  );
  if (!postsRes.ok) {
    throw new Error(`appview status ${postsRes.status}`);
  }
  const body = await postsRes.json() as { posts?: BskyPost[] };
  const posts = body.posts ?? [];

  return posts
    .filter(isMention)
    .map(toMention)
    .sort((a, b) => b.likeCount - a.likeCount)
    .slice(0, MAX_MENTIONS);
}

const fetcher: CachedFetcher<Mention[]> = createCachedFetcher({
  ttlMs: TTL_MS,
  fetch: fetchMentions,
  fallback: [],
  label: "mentions",
});

export function getMentions(): Promise<{ data: Mention[]; stale: boolean }> {
  return fetcher.get();
}
