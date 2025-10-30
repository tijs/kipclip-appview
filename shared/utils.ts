// Shared utility functions for kipclip

/**
 * Encodes an array of tags into a URL-safe string
 * Tags are sorted for consistency, then base64 encoded
 */
export function encodeTagsForUrl(tags: string[]): string {
  if (tags.length === 0) {
    throw new Error("Cannot encode empty tags array");
  }

  // Sort tags for consistent encoding regardless of order
  const sorted = [...tags].sort();

  // Join with a delimiter
  const joined = sorted.join("|");

  // Encode to base64 and make URL-safe
  const base64 = btoa(joined);
  const urlSafe = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "~");

  return urlSafe;
}

/**
 * Decodes a URL-safe encoded string back into an array of tags
 */
export function decodeTagsFromUrl(encoded: string): string[] {
  try {
    // Convert from URL-safe back to standard base64
    const base64 = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/~/g, "=");

    // Decode from base64
    const joined = atob(base64);

    // Split by delimiter
    const tags = joined.split("|");

    // Validate we got at least one tag
    if (tags.length === 0 || tags[0] === "") {
      throw new Error("No valid tags found");
    }

    return tags;
  } catch (err) {
    throw new Error(`Invalid encoded tags: ${err.message}`);
  }
}
