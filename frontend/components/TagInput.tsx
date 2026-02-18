import { useState } from "react";
import type { EnrichedTag } from "../../shared/types.ts";

interface TagInputProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  availableTags: EnrichedTag[];
  disabled?: boolean;
  compact?: boolean;
}

export function TagInput({
  tags,
  onTagsChange,
  availableTags,
  disabled = false,
  compact = false,
}: TagInputProps) {
  const [tagInput, setTagInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = availableTags
    .filter((tag) =>
      tag.value.toLowerCase().includes(tagInput.toLowerCase()) &&
      !tags.includes(tag.value)
    )
    .slice(0, 5);

  function handleAddTag(tagValue: string) {
    if (tagValue && !tags.includes(tagValue)) {
      onTagsChange([...tags, tagValue]);
      setTagInput("");
      setShowSuggestions(false);
    }
  }

  function handleRemoveTag(tagValue: string) {
    onTagsChange(tags.filter((t) => t !== tagValue));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) {
        handleAddTag(suggestions[0].value);
      } else if (tagInput.trim()) {
        handleAddTag(tagInput.trim());
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  const inputPadding = compact ? "px-3 py-2" : "px-4 py-3";

  return (
    <div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-sm"
            >
              {tag}
              <button
                type="button"
                onClick={() => handleRemoveTag(tag)}
                className="text-gray-500 hover:text-red-600 ml-1"
                disabled={disabled}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <input
          type="text"
          value={tagInput}
          onChange={(e) => {
            setTagInput(e.target.value);
            setShowSuggestions(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          placeholder="Add tags..."
          className={`w-full ${inputPadding} rounded-lg border border-gray-300 focus:ring-2 focus:ring-coral focus:border-transparent outline-none transition`}
          disabled={disabled}
        />

        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {suggestions.map((tag) => (
              <button
                key={tag.uri}
                type="button"
                onClick={() => handleAddTag(tag.value)}
                className="w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700 text-sm"
              >
                {tag.value}
              </button>
            ))}
          </div>
        )}
      </div>

      {!compact && (
        <p className="text-xs text-gray-500 mt-2">
          Type to search existing tags or press Enter to create a new one
        </p>
      )}
    </div>
  );
}
