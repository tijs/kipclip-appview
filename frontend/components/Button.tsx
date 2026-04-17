/**
 * Shared button component. Centralises color, padding, shadow, and hover
 * behaviour so affordance tweaks happen in one place.
 *
 * Variants (matches design guide color roles):
 *   primary    — coral fill. Primary CTAs: "Add Bookmark", "Connect".
 *   secondary  — white card with gray ring. Alternative actions:
 *                "Create a new account", "Connect with Bluesky", "Cancel".
 *   danger     — red fill. Destructive actions: "Delete", "Remove".
 *   link       — text-only. Tertiary inline actions: "Back", "Use a
 *                different account".
 *
 * Pass `href` to render an <a> instead of a <button> (same visuals).
 */

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";

type Variant = "primary" | "secondary" | "danger" | "link";

type Size = "sm" | "md";

type CommonProps = {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  leadingIcon?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
  className?: string;
};

type ButtonOnlyProps =
  & CommonProps
  & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps | "href">
  & { href?: undefined };

type AnchorOnlyProps =
  & CommonProps
  & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps | "href">
  & { href: string };

export type ButtonProps = ButtonOnlyProps | AnchorOnlyProps;

const BASE =
  "inline-flex items-center justify-center gap-2 font-semibold rounded-lg " +
  "transition-all duration-150 ease-out active:translate-y-0";

const SIZES: Record<Size, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-5 py-2.5 text-base",
};

// Per-variant resting, hover, and disabled styles. Disabled removes the
// hover lift / shadow change so the button reads as unclickable instead
// of just dimmed.
const VARIANTS: Record<Variant, { enabled: string; disabled: string }> = {
  primary: {
    enabled: "text-white shadow-sm hover:shadow-md hover:-translate-y-px " +
      "[background-color:var(--coral)] " +
      "hover:[background-color:var(--coral-700)]",
    disabled: "text-white shadow-none cursor-not-allowed opacity-60 " +
      "[background-color:var(--coral-200)]",
  },
  secondary: {
    enabled: "bg-white ring-1 ring-gray-200 text-gray-700 shadow-sm " +
      "hover:shadow-md hover:-translate-y-px hover:ring-gray-300",
    disabled: "bg-gray-50 ring-1 ring-gray-200 text-gray-400 shadow-none " +
      "cursor-not-allowed",
  },
  danger: {
    enabled: "text-white shadow-sm hover:shadow-md hover:-translate-y-px " +
      "bg-red-600 hover:bg-red-700",
    disabled: "text-white shadow-none cursor-not-allowed opacity-60 " +
      "bg-red-300",
  },
  link: {
    enabled: "text-gray-500 hover:text-gray-800 hover:bg-gray-100",
    disabled: "text-gray-300 cursor-not-allowed",
  },
};

function classes(
  variant: Variant,
  size: Size,
  fullWidth: boolean,
  disabled: boolean,
  extra?: string,
) {
  return [
    BASE,
    SIZES[size],
    disabled ? VARIANTS[variant].disabled : VARIANTS[variant].enabled,
    fullWidth ? "w-full" : "",
    extra ?? "",
  ].filter(Boolean).join(" ");
}

function Spinner() {
  return (
    <span
      className="inline-block w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"
      aria-hidden
    />
  );
}

export function Button(props: ButtonProps) {
  const {
    variant = "primary",
    size = "md",
    fullWidth = false,
    leadingIcon,
    loading = false,
    children,
    className,
    ...rest
  } = props;

  const isAnchor = "href" in rest && rest.href !== undefined;
  const buttonDisabled = (!isAnchor &&
    (rest as ButtonHTMLAttributes<HTMLButtonElement>).disabled) || false;
  const isDisabled = loading || buttonDisabled;

  const cls = classes(variant, size, fullWidth, isDisabled, className);
  const content = (
    <>
      {loading ? <Spinner /> : leadingIcon}
      {children}
    </>
  );

  if (isAnchor) {
    const anchorProps = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a className={cls} {...anchorProps}>
        {content}
      </a>
    );
  }

  const buttonProps = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button
      className={cls}
      disabled={isDisabled}
      {...buttonProps}
    >
      {content}
    </button>
  );
}
