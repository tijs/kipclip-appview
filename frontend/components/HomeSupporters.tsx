import { useEffect, useState } from "react";
import type { Key } from "react";

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

const SUPPORT_URL = "/support";

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

export function HomeSupporters() {
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
    <section className="px-4 sm:px-6 py-16 sm:py-20">
      <div className="max-w-4xl mx-auto text-center">
        <p
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: "var(--teal)" }}
        >
          Backed by
        </p>
        <h2
          className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4"
          style={{ textWrap: "balance", letterSpacing: "-0.01em" }}
        >
          People who keep kipclip running.
        </h2>
        <p
          className="text-lg text-gray-600 mb-10 max-w-xl mx-auto"
          style={{ textWrap: "pretty" }}
        >
          kipclip is free to use. Supporters chip in via{" "}
          <a
            href="https://atprotofans.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-900"
          >
            atprotofans.com
          </a>{" "}
          to keep the lights on and fund the next features.
        </p>

        {data === null
          ? (
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-6">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex flex-col items-center gap-2">
                  <div className="w-14 h-14 rounded-full bg-gray-200 animate-pulse" />
                  <div className="h-3 w-16 bg-gray-200 rounded animate-pulse" />
                </div>
              ))}
            </div>
          )
          : (
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-6 mb-10">
              {supporters.slice(0, 12).map((s) => (
                <SupporterTile key={s.did} supporter={s} />
              ))}
            </div>
          )}

        <a
          href={SUPPORT_URL}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold ring-1 ring-teal-200 hover:-translate-y-px hover:shadow-md active:scale-[0.96] bg-white"
          style={{
            color: "var(--teal)",
            boxShadow:
              "0 1px 2px rgba(20,30,40,0.04), 0 4px 12px -6px rgba(20,30,40,0.06)",
            transitionProperty: "transform, box-shadow",
            transitionDuration: "150ms",
            transitionTimingFunction: "ease-out",
          }}
        >
          Become a supporter
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
      </div>
    </section>
  );
}
