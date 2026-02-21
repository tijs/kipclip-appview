/**
 * Date formatting preferences.
 * Stored in localStorage, used across all frontend components.
 */

export type DateFormatOption = "us" | "eu" | "eu-dot" | "iso" | "text";

const STORAGE_KEY = "kipclip-date-format";

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export const DATE_FORMATS: {
  id: DateFormatOption;
  label: string;
  format: (d: Date) => string;
}[] = [
  {
    id: "us",
    label: "US",
    format: (d) =>
      `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`,
  },
  {
    id: "eu",
    label: "EU",
    format: (d) =>
      `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
  },
  {
    id: "eu-dot",
    label: "EU (dot)",
    format: (d) =>
      `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`,
  },
  {
    id: "iso",
    label: "ISO",
    format: (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  },
  {
    id: "text",
    label: "Text",
    format: (d) =>
      d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
  },
];

export function getDateFormat(): DateFormatOption {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (DATE_FORMATS.some((f) => f.id === stored)) {
      return stored as DateFormatOption;
    }
  } catch { /* ignore */ }
  return "us";
}

export function setDateFormat(format: DateFormatOption) {
  try {
    localStorage.setItem(STORAGE_KEY, format);
  } catch { /* ignore */ }
}

export function formatDate(isoDate: string): string {
  const format = getDateFormat();
  const d = new Date(isoDate);
  const entry = DATE_FORMATS.find((f) => f.id === format);
  return entry ? entry.format(d) : d.toLocaleDateString();
}
