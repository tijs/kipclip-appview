/**
 * Dismissible "Support kipclip" banner.
 *
 * Rendered above the main bookmark list for non-supporters, and on public
 * shared collection pages as promotional context. Dismiss state is stored
 * in localStorage as an ISO timestamp; the banner re-appears 30 days
 * after the stored dismiss time.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "kipclip-support-banner-dismissed-at";
const REDISPLAY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const dismissedAt = Date.parse(raw);
    if (Number.isNaN(dismissedAt)) return false;
    return Date.now() - dismissedAt < REDISPLAY_MS;
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    // localStorage unavailable — ignore; banner will re-appear next load
  }
}

export function SupportBanner({ href = "/support" }: { href?: string }) {
  // Default `true` so we don't flash the banner before reading localStorage.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(isDismissed());
  }, []);

  if (dismissed) return null;

  function handleDismiss(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    markDismissed();
    setDismissed(true);
  }

  return (
    <div
      className="relative w-full rounded-lg border px-4 py-3 pr-10 mb-4 text-sm flex items-start gap-3"
      style={{
        backgroundColor: "var(--coral-50)",
        borderColor: "var(--coral-200)",
        color: "var(--coral-700)",
      }}
      role="region"
      aria-label="Support kipclip"
    >
      <svg
        className="w-5 h-5 flex-shrink-0 mt-0.5"
        fill="currentColor"
        viewBox="0 0 24 24"
        aria-hidden
      >
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
      <p className="flex-1">
        <span className="font-semibold">Enjoying kipclip?</span>{" "}
        <a href={href} className="underline hover:opacity-80">
          Become a supporter
        </a>{" "}
        to unlock import and help fund ongoing development.
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="absolute top-2 right-2 w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 transition-colors"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
