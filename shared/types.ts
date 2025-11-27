// Shared TypeScript types for kipclip

// AT Protocol bookmark record type
export interface BookmarkRecord {
  subject: string; // URI of the bookmarked content
  createdAt: string; // ISO 8601 datetime
  tags?: string[]; // Optional tags
}

// Enriched bookmark with metadata
export interface EnrichedBookmark extends BookmarkRecord {
  uri: string; // AT Protocol URI for this record
  cid: string; // Content ID
  title?: string; // Extracted page title
  description?: string; // Extracted meta description (future)
  favicon?: string; // Extracted favicon URL (future)
}

// API request/response types
export interface AddBookmarkRequest {
  url: string;
}

export interface AddBookmarkResponse {
  success: boolean;
  bookmark?: EnrichedBookmark;
  error?: string;
}

export interface ListBookmarksResponse {
  bookmarks: EnrichedBookmark[];
}

// URL metadata extraction result
export interface UrlMetadata {
  title?: string;
  description?: string;
  favicon?: string;
}

// Session info
export interface SessionInfo {
  did: string;
  handle: string;
}

// AT Protocol tag record type
export interface TagRecord {
  value: string; // Tag text (max 64 chars)
  createdAt: string; // ISO 8601 datetime
}

// Enriched tag with metadata
export interface EnrichedTag extends TagRecord {
  uri: string; // AT Protocol URI for this record
  cid: string; // Content ID
}

// Tag API request/response types
export interface AddTagRequest {
  value: string;
}

export interface AddTagResponse {
  success: boolean;
  tag?: EnrichedTag;
  error?: string;
}

export interface ListTagsResponse {
  tags: EnrichedTag[];
}

export interface UpdateTagRequest {
  value: string;
}

export interface UpdateTagResponse {
  success: boolean;
  tag?: EnrichedTag;
  error?: string;
}

export interface DeleteTagResponse {
  success: boolean;
  error?: string;
}

// Bookmark tag update request/response types
export interface UpdateBookmarkTagsRequest {
  tags: string[];
  title?: string;
  url?: string;
  description?: string;
}

export interface UpdateBookmarkTagsResponse {
  success: boolean;
  bookmark?: EnrichedBookmark;
  error?: string;
}

// Shared bookmarks API types (public, no auth)
export interface SharedBookmarksResponse {
  bookmarks: EnrichedBookmark[];
  handle: string;
  tags: string[];
  error?: string;
}

// Combined initial data response (for optimized page load)
export interface InitialDataResponse {
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
}
