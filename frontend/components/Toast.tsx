interface ToastProps {
  message: string;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

export function Toast({ message, action, onDismiss }: ToastProps) {
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-gray-800 text-white rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 animate-slide-up"
      role="status"
      aria-live="polite"
    >
      <span className="text-sm">{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="text-sm font-medium px-2 py-1 rounded hover:bg-gray-700 transition-colors"
          style={{ color: "var(--coral)" }}
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-gray-400 hover:text-white ml-1"
          aria-label="Dismiss"
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
      )}
    </div>
  );
}
