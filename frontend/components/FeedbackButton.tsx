import { FEEDBACK_URL } from "../utils/feedback.ts";

// Floating feedback link, pinned bottom-right. Desktop only (hidden on mobile,
// where a persistent FAB would crowd the limited screen space). Sits below the
// bulk-action toolbar (z-30) so it never covers an active selection bar.
export function FeedbackButton() {
  return (
    <a
      href={FEEDBACK_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="hidden md:flex fixed bottom-5 right-5 z-20 items-center gap-2 px-4 py-2.5 rounded-full bg-white text-sm font-medium text-gray-700 shadow-lg border border-gray-200 hover:text-gray-900 hover:shadow-xl transition-all"
      title="Share feedback or request a feature"
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
          d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-4 4v-4z"
        />
      </svg>
      Feedback
    </a>
  );
}
