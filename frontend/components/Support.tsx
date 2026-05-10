import { useEffect, useState } from "react";
import type { Key } from "react";
import { PageShell } from "./PageShell.tsx";
import {
  SupporterHowItWorks,
  SupportOnAtprotofansButton,
} from "./SupporterHowItWorks.tsx";

interface Supporter {
  did: string;
  handle: string;
  displayName: string;
  avatar: string | null;
}

interface SupportersResponse {
  supporters: Supporter[];
  totalCount: number;
}

const ATSTORE_URL = "https://atstore.fyi/products/kipclip";

function hueFromHandle(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) {
    h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

function SupporterTile(
  { supporter }: { key?: Key | null; supporter: Supporter },
) {
  const profileUrl = `https://bsky.app/profile/${supporter.handle}`;
  const initial = supporter.displayName.charAt(0).toUpperCase() || "?";
  return (
    <a
      href={profileUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col items-center gap-2 group"
      title={`${supporter.displayName} (@${supporter.handle})`}
    >
      {supporter.avatar
        ? (
          <img
            src={supporter.avatar}
            alt=""
            width={56}
            height={56}
            className="w-14 h-14 rounded-full object-cover group-hover:-translate-y-px"
            style={{
              outline: "1px solid rgba(20,30,40,0.06)",
              transitionProperty: "transform",
              transitionDuration: "150ms",
              transitionTimingFunction: "ease-out",
            }}
          />
        )
        : (
          <span
            className="w-14 h-14 rounded-full flex items-center justify-center font-semibold text-white text-xl group-hover:-translate-y-px"
            style={{
              backgroundColor: `hsl(${
                hueFromHandle(supporter.handle)
              }, 45%, 55%)`,
              transitionProperty: "transform",
              transitionDuration: "150ms",
              transitionTimingFunction: "ease-out",
            }}
            aria-hidden
          >
            {initial}
          </span>
        )}
      <span className="text-sm font-medium text-gray-700 truncate max-w-full">
        {supporter.displayName}
      </span>
    </a>
  );
}

function SupportersSection() {
  const [data, setData] = useState<SupportersResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/supporters")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then((res: SupportersResponse) => {
        if (cancelled) return;
        setData(res);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return null;
  if (data !== null && data.supporters.length === 0) return null;

  const supporters = data?.supporters ?? [];

  return (
    <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
      <h3 className="text-xl font-bold text-gray-800">
        Current supporters
      </h3>
      <p className="text-gray-700">
        Thanks to these people for chipping in. Want your face here? Support
        kipclip via atprotofans.com above.
      </p>
      {data === null
        ? (
          <div className="flex flex-wrap gap-x-6 gap-y-6">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex flex-col items-center gap-2">
                <div className="w-14 h-14 rounded-full bg-gray-200 animate-pulse" />
                <div className="h-3 w-16 bg-gray-200 rounded animate-pulse" />
              </div>
            ))}
          </div>
        )
        : (
          <div className="flex flex-wrap gap-x-6 gap-y-6">
            {supporters.map((s) => <SupporterTile key={s.did} supporter={s} />)}
          </div>
        )}
    </section>
  );
}

function ReviewInsteadSection() {
  return (
    <section
      className="rounded-lg shadow-md p-6 space-y-4"
      style={{
        background:
          "linear-gradient(135deg, #ffffff 0%, rgba(244, 162, 97, 0.08) 100%)",
      }}
    >
      <h3 className="text-xl font-bold text-gray-800">
        Short on cash? Leave a review.
      </h3>
      <p className="text-gray-700">
        Reviews on{" "}
        <a
          href={ATSTORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-gray-900"
        >
          atstore.fyi
        </a>{" "}
        — the directory for AT Protocol apps — help other people find kipclip
        and keep momentum going. Takes a minute, costs nothing, real impact.
      </p>
      <a
        href={ATSTORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-white hover:-translate-y-px hover:shadow-md active:scale-[0.96]"
        style={{
          backgroundColor: "#f4a261",
          transitionProperty: "transform, box-shadow",
          transitionDuration: "150ms",
          transitionTimingFunction: "ease-out",
        }}
      >
        Review kipclip on atstore.fyi
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14 5l7 7m0 0l-7 7m7-7H3"
          />
        </svg>
      </a>
    </section>
  );
}

export function Support() {
  return (
    <PageShell>
      <section>
        <h2 className="text-3xl font-bold text-gray-800 mb-3">
          Support kipclip
        </h2>
        <p className="text-gray-700 text-lg">
          kipclip is free to use. Your support helps fund ongoing development
          and unlocks supporter-only features like bookmark import.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">
          Become a supporter
        </h3>
        <SupportOnAtprotofansButton />
      </section>

      <SupportersSection />
      <ReviewInsteadSection />
      <SupporterHowItWorks />
    </PageShell>
  );
}
