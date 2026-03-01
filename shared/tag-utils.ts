/**
 * Case-insensitive tag comparison utilities.
 * All tag matching should use these functions to prevent duplicates.
 */

/** Case-insensitive tag equality. */
export function tagsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Case-insensitive replacement for `tags.includes(value)`. */
export function tagIncludes(tags: string[], value: string): boolean {
  return tags.some((t) => t.toLowerCase() === value.toLowerCase());
}

/**
 * Find an existing tag value that case-insensitively matches the candidate.
 * Returns the existing cased version or null if no match.
 */
export function findExistingTag(
  existingValues: string[],
  candidate: string,
): string | null {
  const lower = candidate.toLowerCase();
  return existingValues.find((v) => v.toLowerCase() === lower) ?? null;
}

/**
 * Map input tags to existing casing where a case-insensitive match exists.
 * New tags (no match) keep their original casing.
 * Deduplicates the result case-insensitively, keeping first occurrence.
 */
export function resolveTagCasing(
  inputTags: string[],
  existingTagValues: string[],
): string[] {
  const resolved = inputTags.map((tag) =>
    findExistingTag(existingTagValues, tag) ?? tag
  );
  return deduplicateTagsCaseInsensitive(resolved);
}

/**
 * Deduplicate tags case-insensitively, keeping the first occurrence.
 */
export function deduplicateTagsCaseInsensitive(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(tag);
    }
  }
  return result;
}
