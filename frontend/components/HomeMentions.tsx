import { useEffect, useState } from "react";
import type { Key } from "react";

interface Mention {
  uri: string;
  cid: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  text: string;
  indexedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
}

function postUrl(uri: string): string {
  const parts = uri.replace(/^at:\/\//, "").split("/");
  if (parts.length !== 3) return "https://bsky.app";
  return `https://bsky.app/profile/${parts[0]}/post/${parts[2]}`;
}

function MentionRow(
  { mention }: { key?: Key | null; mention: Mention },
) {
  const text = mention.text.length > 140
    ? mention.text.slice(0, 140).trim() + "…"
    : mention.text;
  return (
    <a
      href={postUrl(mention.uri)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex gap-3 items-start py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50/50 -mx-3 px-3 rounded-lg"
      style={{
        transitionProperty: "background-color",
        transitionDuration: "150ms",
        transitionTimingFunction: "ease-out",
      }}
    >
      {mention.avatar
        ? (
          <img
            src={mention.avatar}
            alt=""
            width={36}
            height={36}
            className="w-9 h-9 rounded-full object-cover flex-shrink-0 mt-0.5"
            style={{ outline: "1px solid rgba(20,30,40,0.06)" }}
          />
        )
        : (
          <div className="w-9 h-9 rounded-full bg-gray-200 flex-shrink-0 mt-0.5" />
        )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="font-semibold text-gray-900 truncate text-sm">
            {mention.displayName}
          </span>
          <span className="text-xs text-gray-500 truncate">
            @{mention.handle}
          </span>
        </div>
        <p
          className="text-sm text-gray-700 leading-snug"
          style={{ textWrap: "pretty" }}
        >
          {text}
        </p>
      </div>
    </a>
  );
}

export function HomeMentions() {
  const [mentions, setMentions] = useState<Mention[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/mentions")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then((data: { mentions: Mention[] }) => {
        if (cancelled) return;
        setMentions(data.mentions ?? []);
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
  if (mentions !== null && mentions.length === 0) return null;

  return (
    <section className="px-4 sm:px-6 py-12 sm:py-16 bg-white/60">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <p
            className="text-sm font-semibold uppercase tracking-wider mb-2"
            style={{ color: "var(--teal)" }}
          >
            Mentions on Bluesky
          </p>
          <p
            className="text-base text-gray-600"
            style={{ textWrap: "pretty" }}
          >
            Posts linking to kipclip.com.
          </p>
        </div>
        {mentions === null
          ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex gap-3 items-start py-3 animate-pulse"
                >
                  <div className="w-9 h-9 rounded-full bg-gray-200 flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 bg-gray-200 rounded" />
                    <div className="h-3 w-full bg-gray-100 rounded" />
                    <div className="h-3 w-5/6 bg-gray-100 rounded" />
                  </div>
                </div>
              ))}
            </div>
          )
          : (
            <div>
              {mentions.slice(0, 6).map((m) => (
                <MentionRow key={m.uri} mention={m} />
              ))}
            </div>
          )}
        <p className="text-center text-xs text-gray-400 mt-8">
          Surfaced via{" "}
          <a
            href="https://www.microcosm.blue/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-600"
          >
            Microcosm Constellation
          </a>
        </p>
      </div>
    </section>
  );
}
