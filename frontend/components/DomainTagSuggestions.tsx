import { useEffect, useState } from "react";
import {
  type DomainTagRule,
  suggestDomainTags,
} from "../../shared/domain-tag-rules.ts";
import type { EnrichedTag } from "../../shared/types.ts";

export function DomainTagSuggestions(
  { url, selected, available, onChange, disabled }: {
    url: string;
    selected: string[];
    available: EnrichedTag[];
    onChange: (tags: string[]) => void;
    disabled?: boolean;
  },
) {
  const [rules, setRules] = useState<DomainTagRule[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/preferences/domain-tags", { credentials: "include" })
      .then((res) => res.ok ? res.json() : Promise.reject())
      .then((data) => {
        if (active) setRules(data.rules ?? []);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const suggestions = suggestDomainTags(
    url,
    rules,
    available.map((tag) => tag.value),
    selected,
  );
  if (unavailable && url.trim()) {
    return (
      <p className="mt-2 text-sm text-gray-600">
        Site tag suggestions are unavailable. You can still add tags manually.
      </p>
    );
  }
  if (!suggestions.length) return null;
  return (
    <div className="mt-2" aria-label="Suggested tags">
      <p className="text-sm text-gray-600">Suggested for this site:</p>
      {suggestions.map((tag) => (
        <button
          key={tag}
          type="button"
          disabled={disabled}
          onClick={() => onChange([...selected, tag])}
          className="mr-2 mt-1 rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
        >
          Add {tag}
        </button>
      ))}
    </div>
  );
}
