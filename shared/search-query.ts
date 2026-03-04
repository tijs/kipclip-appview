/**
 * Pure functions for parsing and manipulating search queries with tag: syntax.
 * No React dependencies — used by both AppContext and tests.
 */

export interface ParsedQuery {
  tags: string[];
  text: string;
}

/**
 * Parse a search query string, extracting `tag:xxx` tokens.
 * - Case-insensitive prefix (`TAG:`, `Tag:`, `tag:` all work)
 * - Tag values are lowercased and deduplicated
 * - `tag:` with no value is treated as literal text
 * - Remaining non-tag tokens are joined as free text
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  const tags: string[] = [];
  const textParts: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (token.toLowerCase().startsWith("tag:") && token.length > 4) {
      const value = token.slice(4).toLowerCase();
      if (!seen.has(value)) {
        seen.add(value);
        tags.push(value);
      }
    } else {
      textParts.push(token);
    }
  }

  return { tags, text: textParts.join(" ") };
}

/**
 * Toggle a tag in a query string.
 * - If the tag is present, removes it
 * - If absent, prepends `tag:tagname` at the start
 * - Case-insensitive matching for removal
 */
export function toggleTagInQuery(query: string, tag: string): string {
  const tagLower = tag.toLowerCase();
  const tokens = query.split(/\s+/).filter((t) => t.length > 0);

  // Check if tag already exists
  const exists = tokens.some((t) =>
    t.toLowerCase().startsWith("tag:") && t.length > 4 &&
    t.slice(4).toLowerCase() === tagLower
  );

  if (exists) {
    // Remove it
    const remaining = tokens.filter((t) =>
      !(t.toLowerCase().startsWith("tag:") && t.length > 4 &&
        t.slice(4).toLowerCase() === tagLower)
    );
    return remaining.join(" ");
  }

  // Prepend
  const prefix = `tag:${tagLower}`;
  return query.trim().length > 0 ? `${prefix} ${query.trim()}` : prefix;
}
