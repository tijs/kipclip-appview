export interface DomainTagRule {
  domain: string;
  tag: string;
}

/** Validate rules at the API boundary; wildcards and subdomains are explicit. */
export function validateDomainTagRules(
  value: unknown,
): value is DomainTagRule[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every((rule) => {
    if (
      !rule || typeof rule.domain !== "string" || typeof rule.tag !== "string"
    ) return false;
    if (
      !rule.domain || rule.domain.length > 253 || !rule.tag ||
      new TextEncoder().encode(rule.tag).length > 64
    ) return false;
    if (
      !rule.domain.split(".").every((label: string) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
      )
    ) return false;
    try {
      const url = new URL(`https://${rule.domain}`);
      return url.hostname === rule.domain.toLowerCase() && !url.port &&
        url.pathname === "/" &&
        !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  });
}

/** Suggest existing tags for the exact hostname without changing the selection. */
export function suggestDomainTags(
  input: string,
  rules: DomainTagRule[],
  available: string[],
  selected: string[],
): string[] {
  let host: string;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return [];
    host = url.hostname.toLowerCase();
  } catch {
    return [];
  }
  const seen = new Set(selected.map((tag) => tag.toLowerCase()));
  const result: string[] = [];
  for (const rule of rules) {
    if (rule.domain.toLowerCase() !== host) continue;
    const tag = available.find((value) =>
      value.toLowerCase() === rule.tag.toLowerCase()
    );
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      result.push(tag);
    }
  }
  return result;
}
