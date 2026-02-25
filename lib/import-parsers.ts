/**
 * Bookmark import parsers for multiple formats.
 * Supports Netscape HTML, Pinboard JSON, Pocket CSV, and Instapaper CSV.
 */

import type { ImportedBookmark } from "../shared/types.ts";

export type ImportFormat = "netscape" | "pinboard" | "pocket" | "instapaper";

/**
 * Auto-detect the format of a bookmark file from its content.
 */
export function detectFormat(content: string): ImportFormat | null {
  const trimmed = content.trim();

  // Netscape HTML bookmark format
  if (
    trimmed.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file") ||
    trimmed.includes("<DT><A HREF")
  ) {
    return "netscape";
  }

  // Try JSON (Pinboard)
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && "href" in parsed[0]) {
        return "pinboard";
      }
    } catch { /* not valid JSON */ }
  }

  // CSV formats — check first line for headers
  const firstLine = trimmed.split("\n")[0].toLowerCase();
  if (firstLine.includes("url") && firstLine.includes("title")) {
    // Instapaper has URL,Title,Selection,Folder
    if (firstLine.includes("selection") && firstLine.includes("folder")) {
      return "instapaper";
    }
    // Pocket has url,title,tags or given_url,given_title
    return "pocket";
  }

  return null;
}

/**
 * Parse a bookmark file, auto-detecting format.
 */
export function parseBookmarkFile(
  content: string,
): { format: string; bookmarks: ImportedBookmark[] } {
  const format = detectFormat(content);
  if (!format) {
    throw new Error(
      "Unrecognized file format. Supported: Netscape HTML, Pinboard JSON, Pocket CSV, Instapaper CSV.",
    );
  }

  const parsers: Record<ImportFormat, (c: string) => ImportedBookmark[]> = {
    netscape: parseNetscapeHtml,
    pinboard: parsePinboardJson,
    pocket: parsePocketCsv,
    instapaper: parseInstapaperCsv,
  };

  return { format, bookmarks: parsers[format](content) };
}

/**
 * Validate that a URL is a valid HTTP(S) URL.
 */
function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Convert a Unix timestamp (seconds) to ISO 8601.
 */
function unixToIso(timestamp: string | number): string | undefined {
  const seconds = typeof timestamp === "string"
    ? parseInt(timestamp, 10)
    : timestamp;
  if (isNaN(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Netscape HTML Parser
// ---------------------------------------------------------------------------

export function parseNetscapeHtml(html: string): ImportedBookmark[] {
  const bookmarks: ImportedBookmark[] = [];
  // Match <DT><A HREF="..." ...>title</A>
  const linkRegex = /<DT><A\s+([^>]*)>([\s\S]*?)<\/A>/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const attrs = match[1];
    const title = match[2].trim();

    const hrefMatch = attrs.match(/HREF="([^"]*)"/i);
    if (!hrefMatch) continue;

    const url = hrefMatch[1];
    if (!isValidHttpUrl(url)) continue;

    const addDateMatch = attrs.match(/ADD_DATE="([^"]*)"/i);
    const tagsMatch = attrs.match(/TAGS="([^"]*)"/i);

    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    bookmarks.push({
      url,
      title: title || undefined,
      tags,
      createdAt: addDateMatch ? unixToIso(addDateMatch[1]) : undefined,
    });
  }

  return bookmarks;
}

// ---------------------------------------------------------------------------
// Pinboard JSON Parser
// ---------------------------------------------------------------------------

interface PinboardEntry {
  href: string;
  description?: string;
  extended?: string;
  tags?: string;
  time?: string;
}

export function parsePinboardJson(json: string): ImportedBookmark[] {
  let entries: PinboardEntry[];
  try {
    entries = JSON.parse(json);
  } catch {
    return [];
  }

  if (!Array.isArray(entries)) return [];

  return entries
    .filter((e) => e.href && isValidHttpUrl(e.href))
    .map((e) => ({
      url: e.href,
      title: e.description || undefined,
      description: e.extended || undefined,
      tags: e.tags
        ? e.tags.split(" ").map((t) => t.trim()).filter(Boolean)
        : [],
      createdAt: e.time || undefined,
    }));
}

// ---------------------------------------------------------------------------
// CSV Parser (shared)
// ---------------------------------------------------------------------------

/**
 * Simple CSV parser that handles quoted fields.
 * No external dependencies.
 */
function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  const lines = csv.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    rows.push(parseCsvLine(line));
  }

  return rows;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ",") {
        fields.push(current.trim());
        current = "";
        i++;
      } else {
        current += char;
        i++;
      }
    }
  }

  fields.push(current.trim());
  return fields;
}

/**
 * Parse CSV into an array of objects using the header row as keys.
 */
function csvToObjects(csv: string): Record<string, string>[] {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.toLowerCase());
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] || "";
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Pocket CSV Parser
// ---------------------------------------------------------------------------

export function parsePocketCsv(csv: string): ImportedBookmark[] {
  const records = csvToObjects(csv);

  return records
    .filter((r) => {
      const url = r.given_url || r.url;
      return url && isValidHttpUrl(url);
    })
    .map((r) => {
      const url = r.given_url || r.url;
      const title = r.given_title || r.title;
      const tags = r.tags
        ? r.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      const createdAt = r.time_added ? unixToIso(r.time_added) : undefined;

      return {
        url,
        title: title || undefined,
        tags,
        createdAt,
      };
    });
}

// ---------------------------------------------------------------------------
// Instapaper CSV Parser
// ---------------------------------------------------------------------------

export function parseInstapaperCsv(csv: string): ImportedBookmark[] {
  const records = csvToObjects(csv);

  return records
    .filter((r) => r.url && isValidHttpUrl(r.url))
    .map((r) => {
      const tags = r.folder && r.folder !== "Unread" && r.folder !== "Archive"
        ? [r.folder]
        : [];
      const createdAt = r.timestamp ? unixToIso(r.timestamp) : undefined;

      return {
        url: r.url,
        title: r.title || undefined,
        description: r.selection || undefined,
        tags,
        createdAt,
      };
    });
}
