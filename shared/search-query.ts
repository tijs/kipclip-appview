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
 * - Quotes keep multi-word tags together: `tag:"animated short"`
 * - Known tags allow unquoted multi-word input: `tag:animated short`
 * - `tag:` with no value is treated as literal text
 * - Remaining non-tag tokens are joined as free text
 */
function tokenizeQuery(raw: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;

  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted;
    } else if (/\s/.test(char) && !quoted) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += char;
    }
  }

  if (token) tokens.push(token);
  return tokens;
}

export function parseSearchQuery(
  raw: string,
  knownTags: string[] = [],
): ParsedQuery {
  const tokens = tokenizeQuery(raw);
  const tags: string[] = [];
  const textParts: string[] = [];
  const seen = new Set<string>();
  const known = new Set(knownTags.map((t) => t.toLowerCase()));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.toLowerCase().startsWith("tag:") && token.length > 4) {
      let value = token.slice(4).toLowerCase();
      let end = i;
      let candidate = value;

      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].toLowerCase().startsWith("tag:")) break;
        candidate += ` ${tokens[j].toLowerCase()}`;
        if (known.has(candidate)) {
          value = candidate;
          end = j;
        }
      }

      i = end;
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
 * - Multi-word tags are quoted
 * - Case-insensitive matching for removal
 */
export function toggleTagInQuery(
  query: string,
  tag: string,
  knownTags: string[] = [],
): string {
  const tagLower = tag.toLowerCase();
  const tokens = tokenizeQuery(query);
  const known = new Set([...knownTags, tag].map((t) => t.toLowerCase()));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.toLowerCase().startsWith("tag:") || token.length <= 4) continue;

    let value = token.slice(4).toLowerCase();
    let end = i;
    let candidate = value;

    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].toLowerCase().startsWith("tag:")) break;
      candidate += ` ${tokens[j].toLowerCase()}`;
      if (known.has(candidate)) {
        value = candidate;
        end = j;
      }
    }

    if (value === tagLower) {
      return tokens.filter((_, idx) => idx < i || idx > end).join(" ");
    }
  }

  const prefix = /\s/.test(tagLower) ? `tag:"${tagLower}"` : `tag:${tagLower}`;
  return query.trim().length > 0 ? `${prefix} ${query.trim()}` : prefix;
}
