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
