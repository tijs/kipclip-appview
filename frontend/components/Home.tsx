import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Button } from "./Button.tsx";
import {
  getSavedIdentities,
  type SavedIdentity,
} from "../utils/saved-identities.ts";
import {
  AtprotoExplainer,
  EuPrivacy,
  FinalCta,
  Positioning,
  Preview,
  Tools,
} from "./HomeSections.tsx";
import { HomeMentions } from "./HomeMentions.tsx";
import { HomeReviews } from "./HomeReviews.tsx";
import { HomeSupporters } from "./HomeSupporters.tsx";

const HERO_IMG = "https://cdn.kipclip.com/images/kip-satchel-transparent.png";

function stagger(ms: number): CSSProperties {
  return { animationDelay: `${ms}ms`, animationFillMode: "both" };
}

function hueFromHandle(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) {
    h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function ContinueAsChip({ identity }: { identity: SavedIdentity }) {
  const initial = identity.handle.replace(/^@/, "").charAt(0).toUpperCase() ||
    "?";
  const hue = hueFromHandle(identity.handle);

  function onClick() {
    globalThis.location.href = `/login?handle=${
      encodeURIComponent(identity.handle)
    }`;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex items-center gap-3 pl-2 pr-5 py-2 rounded-full bg-white ring-1 ring-gray-200/80 hover:-translate-y-px hover:ring-gray-300 active:scale-[0.96]"
      style={{
        transitionProperty: "transform, box-shadow, border-color",
        transitionDuration: "150ms",
        transitionTimingFunction: "ease-out",
        minHeight: "44px",
        boxShadow:
          "0 1px 2px rgba(20,30,40,0.04), 0 8px 20px -6px rgba(20,30,40,0.10)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow =
          "0 1px 2px rgba(20,30,40,0.04), 0 14px 28px -8px rgba(20,30,40,0.16)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow =
          "0 1px 2px rgba(20,30,40,0.04), 0 8px 20px -6px rgba(20,30,40,0.10)";
      }}
      aria-label={`Continue as ${identity.handle}`}
    >
      {identity.avatar
        ? (
          <img
            src={identity.avatar}
            alt=""
            width={32}
            height={32}
            className="w-8 h-8 rounded-full object-cover"
          />
        )
        : (
          <span
            className="w-8 h-8 rounded-full flex items-center justify-center font-semibold text-white text-sm"
            style={{ backgroundColor: `hsl(${hue}, 45%, 55%)` }}
            aria-hidden
          >
            {initial}
          </span>
        )}
      <span className="text-left">
        <span className="block text-[11px] leading-tight text-gray-500">
          Continue as
        </span>
        <span className="block text-sm font-semibold text-gray-800 leading-tight">
          @{identity.handle}
        </span>
      </span>
      <svg
        className="w-4 h-4 text-gray-400 group-hover:text-gray-600"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

export function Home() {
  const [identities] = useState<SavedIdentity[]>(getSavedIdentities);
  const primary = identities[0];
  const [userCount, setUserCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stats")
      .then((r) => r.ok ? r.json() : null)
      .then((data: { userCount?: number } | null) => {
        if (cancelled || !data?.userCount) return;
        setUserCount(data.userCount);
      })
      .catch(() => {/* fail silent — section hides */});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:
          "linear-gradient(135deg, var(--cream) 0%, #faf6ec 50%, #f0e9d6 100%)",
      }}
    >
      <div
        style={{
          background:
            "linear-gradient(180deg, #e9efee 0%, #eef0e8 70%, var(--cream) 100%)",
        }}
      >
        <header className="px-4 sm:px-6 py-4 flex items-center justify-between max-w-6xl mx-auto w-full">
          <a href="/" className="flex items-center gap-2 group">
            <img
              src="https://cdn.kipclip.com/images/kip-vignette.png"
              alt=""
              className="w-8 h-8"
            />
            <span
              className="text-xl font-bold"
              style={{ color: "var(--coral)" }}
            >
              kipclip
            </span>
          </a>
          <nav className="flex items-center gap-2">
            <Button
              href="/signin"
              variant="link"
              size="sm"
              className="min-h-10"
            >
              Sign in
            </Button>
            <Button
              href="/signin"
              variant="primary"
              size="sm"
              className="min-h-10"
            >
              Get started
            </Button>
          </nav>
        </header>

        <section className="flex items-center justify-center px-4 sm:px-6 pt-8 pb-16 sm:pt-12 sm:pb-24">
          <div className="max-w-3xl w-full text-center">
            <img
              src={HERO_IMG}
              alt="Kip the chicken with a bookmark satchel"
              className="w-44 h-44 sm:w-56 sm:h-56 mx-auto mb-8 object-contain fade-in"
              style={{
                ...stagger(0),
                filter:
                  "drop-shadow(0 1px 1px rgba(20,30,40,0.08)) drop-shadow(0 16px 28px rgba(20,30,40,0.12))",
              }}
            />
            <h1
              className="text-4xl sm:text-5xl md:text-6xl font-bold text-gray-900 mb-5 fade-in"
              style={{
                ...stagger(80),
                textWrap: "balance",
                letterSpacing: "-0.02em",
              }}
            >
              Bookmarks you actually own.
            </h1>
            <p
              className="text-lg sm:text-xl text-gray-600 mb-9 max-w-xl mx-auto fade-in"
              style={{ ...stagger(160), textWrap: "pretty" }}
            >
              Save, tag, and share links from any device. Your bookmarks live in
              your own account, not ours — so they're yours to keep, move, or
              delete.
            </p>

            <div
              className="flex flex-col sm:flex-row gap-3 justify-center items-center mb-6 fade-in"
              style={stagger(240)}
            >
              {primary
                ? (
                  <>
                    <ContinueAsChip identity={primary} />
                    <Button href="/signin" variant="link" size="sm">
                      Use a different account
                    </Button>
                  </>
                )
                : (
                  <>
                    <Button href="/signin" variant="primary">
                      Get started — it's free
                    </Button>
                    <Button href="/signin" variant="secondary">
                      Sign in
                    </Button>
                  </>
                )}
            </div>

            {userCount !== null && userCount > 0 && (
              <p
                className="text-sm text-gray-600 mb-3 fade-in"
                style={{
                  ...stagger(280),
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                Join{" "}
                <span className="font-semibold text-gray-900">
                  {userCount.toLocaleString("en-US")}
                </span>{" "}
                people already using kipclip.
              </p>
            )}

            <p
              className="text-sm text-gray-500 fade-in inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1"
              style={stagger(360)}
            >
              <span>Free</span>
              <span aria-hidden>·</span>
              <a
                href="https://tangled.org/tijs.org/kipclip-appview"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 hover:text-gray-700"
                title="Source on Tangled"
              >
                <img
                  src="https://cdn.kipclip.com/images/tangled.svg"
                  alt=""
                  width={14}
                  height={14}
                  className="opacity-80"
                />
                Open source
              </a>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden style={{ fontSize: "1rem", lineHeight: 1 }}>
                  🇪🇺
                </span>
                Hosted in the EU
              </span>
            </p>
          </div>
        </section>
      </div>

      <main className="flex-1">
        <Positioning />
        <Preview />
        <AtprotoExplainer />
        <Tools />
        <HomeReviews />
        <HomeMentions />
        <HomeSupporters />
        <EuPrivacy />
        <FinalCta hasIdentity={!!primary} />
      </main>
    </div>
  );
}
