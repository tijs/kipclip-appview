import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { CompatibleApps } from "./HomeCompatibleApps.tsx";

const CARD_SHADOW =
  "0 1px 2px rgba(20,30,40,0.04), 0 8px 24px -8px rgba(20,30,40,0.08)";
const CARD_CLASS = "bg-white rounded-2xl p-6 sm:p-7 ring-1 ring-gray-100";

function SectionHeading(
  { eyebrow, title, subtitle }: {
    eyebrow?: string;
    title: string;
    subtitle?: string;
  },
) {
  return (
    <div className="max-w-2xl mx-auto text-center mb-12">
      {eyebrow && (
        <p
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: "var(--teal)" }}
        >
          {eyebrow}
        </p>
      )}
      <h2
        className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4"
        style={{ textWrap: "balance", letterSpacing: "-0.01em" }}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          className="text-lg text-gray-600"
          style={{ textWrap: "pretty" }}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

function FeatureCard(
  { icon, title, body }: {
    icon: ReactNode;
    title: string;
    body: ReactNode;
  },
) {
  return (
    <div className={CARD_CLASS} style={{ boxShadow: CARD_SHADOW }}>
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
        style={{
          backgroundColor: "rgba(91, 138, 143, 0.10)",
          color: "var(--teal)",
        }}
      >
        {icon}
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p
        className="text-gray-600 leading-relaxed"
        style={{ textWrap: "pretty" }}
      >
        {body}
      </p>
    </div>
  );
}

function PointCard({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className={CARD_CLASS} style={{ boxShadow: CARD_SHADOW }}>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p
        className="text-gray-600 leading-relaxed"
        style={{ textWrap: "pretty" }}
      >
        {body}
      </p>
    </div>
  );
}

export function Positioning() {
  return (
    <section className="px-4 sm:px-6 py-16 sm:py-24 bg-white/60">
      <div className="max-w-5xl mx-auto">
        <SectionHeading
          eyebrow="What it is"
          title="Like Pinboard, Pocket, or Raindrop — but portable."
          subtitle="A no-nonsense bookmark manager. Tags instead of folders. Built for the web you actually read, not for ad targeting."
        />
        <div className="grid sm:grid-cols-3 gap-4 sm:gap-5">
          <FeatureCard
            icon={
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z"
                />
              </svg>
            }
            title="Save anywhere"
            body="Bookmarklet, iOS shortcut, Android share target, or PWA. One tap from any browser or app."
          />
          <FeatureCard
            icon={
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 7h.01M7 3h5a2 2 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"
                />
              </svg>
            }
            title="Organize with tags"
            body="Free-form tags, no folder hierarchy to fight with. Reading list view for the stuff you'll actually read later."
          />
          <FeatureCard
            icon={
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                />
              </svg>
            }
            title="Share collections"
            body="Every tag is a shareable collection with its own URL, social previews, and RSS feed. Curate in public."
          />
        </div>
      </div>
    </section>
  );
}

export function AtprotoExplainer() {
  return (
    <section className="px-4 sm:px-6 py-16 sm:py-24">
      <div className="max-w-4xl mx-auto">
        <SectionHeading
          eyebrow="Why it matters"
          title="Your data lives in your account."
          subtitle="kipclip is built on AT Protocol — the same open standard behind Bluesky. We don't have a database of your bookmarks. You do."
        />
        <div className="grid md:grid-cols-2 gap-4 sm:gap-5 mb-10">
          <PointCard
            title="Stored on your PDS"
            body="Every bookmark, tag, and note is a record in your Personal Data Server — the same place your Bluesky posts live. kipclip just reads and writes them."
          />
          <PointCard
            title="Open lexicon, no lock-in"
            body={
              <>
                Bookmarks use the{" "}
                <a
                  href="https://github.com/lexicon-community/lexicon/blob/main/community/lexicon/bookmarks/bookmark.json"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-900"
                >
                  community bookmark lexicon
                </a>. Other AT Protocol apps can read and write the same
                records.
              </>
            }
          />
          <PointCard
            title="Outlives the app"
            body={
              <>
                If kipclip ever shuts down, your bookmarks travel with your
                account. Pick another client, or self-host — kipclip is{" "}
                <a
                  href="https://tangled.org/tijs.org/kipclip-appview"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-900"
                >
                  open source
                </a>.
              </>
            }
          />
          <PointCard
            title="Like email — you own the address"
            body="Use a Bluesky handle or your own domain. Switch clients without losing data, the same way you switch email apps."
          />
        </div>

        <CompatibleApps />

        <p className="text-center text-sm text-gray-500">
          Don't have an account yet? Sign up with{" "}
          <a
            href="https://bsky.app"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-700"
          >
            Bluesky
          </a>,{" "}
          <a
            href="https://blacksky.community"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-700"
          >
            Blacksky
          </a>, or{" "}
          <a
            href="https://www.eurosky.tech/register"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-700"
          >
            Eurosky
          </a>{" "}
          — works across the whole Atmosphere.
        </p>
      </div>
    </section>
  );
}

export function Tools() {
  const link = (href: string, label: string) => (
    <a
      href={href}
      className="font-semibold text-gray-900 underline decoration-2 underline-offset-4 hover:decoration-[var(--coral)]"
      style={{
        textDecorationColor: "rgba(91, 138, 143, 0.45)",
        textDecorationThickness: "2px",
        textUnderlineOffset: "4px",
        transitionProperty: "text-decoration-color",
        transitionDuration: "150ms",
      }}
    >
      {label}
    </a>
  );
  return (
    <section className="px-4 sm:px-6 py-16 sm:py-24 bg-white/60">
      <div className="max-w-3xl mx-auto text-center">
        <p
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: "var(--teal)" }}
        >
          Save from anywhere
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold text-gray-900 mb-6"
          style={{ textWrap: "balance", letterSpacing: "-0.01em" }}
        >
          One bookmark, every device.
        </h2>
        <p
          className="text-lg sm:text-xl text-gray-700 leading-relaxed"
          style={{ textWrap: "pretty" }}
        >
          Save with the {link("/tools#bookmarklet", "bookmarklet")}{" "}
          on desktop, an {link("/tools#ios-shortcut", "iOS Shortcut")}{" "}
          on your phone, or the{" "}
          {link("/tools#android", "Android share menu")}. Install kipclip as a
          {" "}
          {link("/tools#pwa", "PWA")} for one-tap access. Every tag becomes a
          {" "}
          {link("/tools", "public collection")} with its own URL and{" "}
          {link("/faq#does-kipclip-support-rss-feeds", "RSS feed")}.
        </p>
      </div>
    </section>
  );
}

export function FinalCta({ hasIdentity }: { hasIdentity: boolean }) {
  return (
    <section className="px-4 sm:px-6 py-20 sm:py-28">
      <div className="max-w-2xl mx-auto text-center">
        <p
          className="italic text-base mb-3"
          style={{ color: "var(--coral)" }}
        >
          You find it, you kip it.
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4"
          style={{ textWrap: "balance", letterSpacing: "-0.01em" }}
        >
          Ready to kip?
        </h2>
        <p
          className="text-lg text-gray-600 mb-8"
          style={{ textWrap: "pretty" }}
        >
          {hasIdentity
            ? "Pick up where you left off — your bookmarks are waiting."
            : "Sign up free with any AT Protocol account. Takes a minute."}
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
          <Button href="/signin" variant="primary">
            Get started — it's free
          </Button>
          <Button href="/signin" variant="secondary">
            Sign in
          </Button>
        </div>
        <p className="mt-8 text-sm text-gray-500">
          Open source on{" "}
          <a
            href="https://tangled.org/tijs.org/kipclip-appview"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-700"
          >
            Tangled
          </a>{" "}
          ·{" "}
          <a
            href="/faq"
            className="underline hover:text-gray-700"
          >
            FAQ
          </a>{" "}
          ·{" "}
          <a
            href="/about"
            className="underline hover:text-gray-700"
          >
            About
          </a>{" "}
          ·{" "}
          <a
            href="/press"
            className="underline hover:text-gray-700"
          >
            Press
          </a>{" "}
          ·{" "}
          <a
            href="/privacy"
            className="underline hover:text-gray-700"
          >
            Privacy
          </a>
        </p>
      </div>
    </section>
  );
}

export function EuPrivacy() {
  return (
    <section className="px-4 sm:px-6 py-16 sm:py-24 bg-white/60">
      <div className="max-w-3xl mx-auto">
        <div
          className="bg-white rounded-2xl p-8 sm:p-10 ring-1 ring-gray-100 flex flex-col sm:flex-row gap-6 items-start"
          style={{ boxShadow: CARD_SHADOW }}
        >
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{
              backgroundColor: "rgba(91, 138, 143, 0.10)",
              color: "var(--teal)",
            }}
          >
            <svg
              className="w-7 h-7"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.8}
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
          </div>
          <div>
            <p
              className="text-sm font-semibold uppercase tracking-wider mb-2"
              style={{ color: "var(--teal)" }}
            >
              EU hosted · GDPR friendly
            </p>
            <h2
              className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3"
              style={{ textWrap: "balance" }}
            >
              Hosted in Germany. No tracking pixels.
            </h2>
            <p
              className="text-gray-600 leading-relaxed"
              style={{ textWrap: "pretty" }}
            >
              kipclip runs on a Hetzner server in Germany. We use{" "}
              <a
                href="https://www.simpleanalytics.com/?referral=woceg"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gray-900"
              >
                privacy-first analytics
              </a>{" "}
              (no cookies, no fingerprints, no ad networks). Your bookmarks
              aren't sold, mined, or rented out — they're not even ours to sell.
              See the{" "}
              <a
                href="/privacy"
                className="underline hover:text-gray-900"
              >
                privacy policy
              </a>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
