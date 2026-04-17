/**
 * Shared tag/pill component. Centralises tag styling so every surface
 * (filter chips, sidebar rows, card tags, public collection filters)
 * reads the same.
 *
 * Variants (match design guide color roles):
 *   selected   — teal filled. Active filter or selection state.
 *   unselected — gray-100 fill. Clickable but not active.
 *   outlined   — white + gray ring. Suggestion / matching tag.
 *   neutral    — gray-100 fill. Non-interactive display tag.
 *   destructive — red-50 + red-700. Selected state when the action is a
 *                 destructive bulk op (e.g. "Remove Tags").
 *
 * Shapes:
 *   pill — rounded-full, tighter padding. Default for inline tag lists.
 *   row  — rounded-lg, more padding. Sidebar rows with icons/actions.
 *
 * Sizes: sm (default) | xs (for dense card footers).
 *
 * Pass `removable` to show a trailing × affordance. Pass `checked` to
 * show a leading ✓ icon. Pass `onClick` to render a <button>; omit it
 * for a non-interactive <span>.
 */

import type { ReactNode } from "react";

type Variant =
  | "selected"
  | "unselected"
  | "outlined"
  | "neutral"
  | "destructive";

type Shape = "pill" | "row";
type Size = "xs" | "sm";

interface TagProps {
  children: ReactNode;
  variant?: Variant;
  shape?: Shape;
  size?: Size;
  removable?: boolean;
  checked?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  className?: string;
}

const SHAPE: Record<Shape, string> = {
  pill: "rounded-full",
  row: "rounded-lg",
};

const SIZE: Record<Size, string> = {
  xs: "px-2 py-0.5 text-xs",
  sm: "px-3 py-1 text-sm",
};

const VARIANT: Record<Variant, string> = {
  selected: "coral-selected",
  unselected: "bg-gray-100 text-gray-700 hover:bg-gray-200",
  outlined:
    "bg-white text-gray-700 ring-1 ring-gray-200 hover:ring-gray-300 hover:bg-gray-50",
  neutral: "bg-gray-100 text-gray-700",
  destructive: "bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100",
};

const BASE =
  "inline-flex items-center gap-1.5 font-medium transition-colors whitespace-nowrap";

function CheckIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.5}
        d="M5 13l4 4L19 7"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 shrink-0 opacity-70"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

export function Tag({
  children,
  variant = "neutral",
  shape = "pill",
  size = "sm",
  removable = false,
  checked = false,
  onClick,
  title,
  className,
}: TagProps) {
  const cls = [
    BASE,
    SHAPE[shape],
    SIZE[size],
    VARIANT[variant],
    onClick ? "cursor-pointer" : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  const content = (
    <>
      {checked && <CheckIcon />}
      <span className="truncate">{children}</span>
      {removable && <CloseIcon />}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} title={title}>
        {content}
      </button>
    );
  }
  return (
    <span className={cls} title={title}>
      {content}
    </span>
  );
}
