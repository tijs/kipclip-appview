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
  description?: string; // Extracted meta description
  favicon?: string; // Extracted favicon URL
  image?: string; // Preview image (og:image)
  note?: string; // User note from annotation sidecar
}

// Kipclip annotation sidecar record (com.kipclip.annotation)
export interface AnnotationRecord {
  subject: string; // AT URI of the bookmark this annotates
  note?: string; // User note
  title?: string;
  description?: string;
  favicon?: string;
  image?: string;
  createdAt: string;
}

// API request/response types
export interface AddBookmarkRequest {
  url: string;
  tags?: string[];
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
  image?: string; // Preview image (og:image)
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
  note?: string;
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

// User settings (stored in database)
export interface UserSettings {
  instapaperEnabled: boolean;
  instapaperUsername?: string; // Decrypted, only in memory (never includes password)
}

// Settings API response
export interface GetSettingsResponse {
  settings: UserSettings;
}

// Settings API update request
export interface UpdateSettingsRequest {
  instapaperEnabled?: boolean;
  instapaperUsername?: string;
  instapaperPassword?: string; // Only when updating credentials
}

// Settings API update response
export interface UpdateSettingsResponse {
  success: boolean;
  settings?: UserSettings;
  error?: string;
}

// Duplicate check API types
export interface CheckDuplicatesRequest {
  url: string;
}

export interface CheckDuplicatesResponse {
  duplicates: EnrichedBookmark[];
}

// User preferences (stored on PDS as com.kipclip.preferences)
export interface PreferencesRecord {
  dateFormat: string;
  readingListTag?: string;
  createdAt: string;
}

export interface UserPreferences {
  dateFormat: string;
  readingListTag: string;
}

export interface UpdatePreferencesRequest {
  dateFormat?: string;
  readingListTag?: string;
}

export interface UpdatePreferencesResponse {
  success: boolean;
  preferences?: UserPreferences;
  error?: string;
}

// Combined initial data response (for optimized page load)
export interface InitialDataResponse {
  bookmarks: EnrichedBookmark[];
  tags: EnrichedTag[];
  settings: UserSettings;
  preferences: UserPreferences;
}

// Import types
export interface ImportedBookmark {
  url: string;
  title?: string;
  description?: string;
  tags: string[];
  createdAt?: string; // ISO 8601, falls back to now
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  format: string;
}

export interface ImportResponse {
  success: boolean;
  result?: ImportResult;
  error?: string;
}
