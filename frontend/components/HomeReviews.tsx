import { useEffect, useState } from "react";
import type { Key } from "react";

interface Review {
  id: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  text: string;
  rating: number;
  createdAt: string;
  atstoreUrl: string;
}

const CARD_SHADOW =
  "0 1px 2px rgba(20,30,40,0.04), 0 8px 24px -8px rgba(20,30,40,0.08)";

function Stars({ rating }: { rating: number }) {
  const total = 5;
  return (
    <div
      className="inline-flex items-center gap-0.5"
      aria-label={`${rating} out of 5 stars`}
      style={{ color: "#f4a261" /* orange role: celebration */ }}
    >
      {Array.from({ length: total }, (_, i) => (
        <svg
          key={i}
          className="w-4 h-4"
          fill={i < rating ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={1.5}
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.32.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.32-.988l5.518-.442a.563.563 0 00.475-.345l2.126-5.111z"
          />
        </svg>
      ))}
    </div>
  );
}

function ReviewCard(
  { review }: { key?: Key | null; review: Review },
) {
  return (
    <a
      href={review.atstoreUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-white rounded-2xl p-5 sm:p-6 ring-1 ring-gray-100 hover:-translate-y-px hover:shadow-md"
      style={{
        boxShadow: CARD_SHADOW,
        transitionProperty: "transform, box-shadow",
        transitionDuration: "150ms",
        transitionTimingFunction: "ease-out",
      }}
    >
      <div className="flex items-center gap-3 mb-3">
        {review.avatar
          ? (
            <img
              src={review.avatar}
              alt=""
              width={40}
              height={40}
              className="w-10 h-10 rounded-full object-cover"
              style={{ outline: "1px solid rgba(20,30,40,0.06)" }}
            />
          )
          : (
            <div
              className="w-10 h-10 rounded-full bg-gray-200"
              aria-hidden
            />
          )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-900 truncate">
            {review.displayName}
          </div>
          <div className="text-sm text-gray-500 truncate">
            @{review.handle}
          </div>
        </div>
        <Stars rating={review.rating} />
      </div>
      <p
        className="text-gray-700 leading-relaxed line-clamp-5"
        style={{ textWrap: "pretty" }}
      >
        {review.text}
      </p>
    </a>
  );
}

function SectionHeading() {
  return (
    <div className="max-w-2xl mx-auto text-center mb-12">
      <p
        className="text-sm font-semibold uppercase tracking-wider mb-3"
        style={{ color: "var(--teal)" }}
      >
        Reviews
      </p>
      <h2
        className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4"
        style={{ textWrap: "balance", letterSpacing: "-0.01em" }}
      >
        What people are saying.
      </h2>
      <p
        className="text-lg text-gray-600"
        style={{ textWrap: "pretty" }}
      >
        From kipclip's listing on atstore.fyi — the directory for AT Protocol
        apps.
      </p>
    </div>
  );
}

export function HomeReviews() {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reviews")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)))
      .then((data: { reviews: Review[] }) => {
        if (cancelled) return;
        setReviews(data.reviews ?? []);
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
  if (reviews !== null && reviews.length === 0) return null;

  return (
    <section className="px-4 sm:px-6 py-16 sm:py-24">
      <div className="max-w-5xl mx-auto">
        <SectionHeading />
        {reviews === null
          ? (
            <div
              className="grid gap-4 sm:gap-5 justify-center"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 360px))",
              }}
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="bg-white rounded-2xl p-5 sm:p-6 ring-1 ring-gray-100 animate-pulse"
                  style={{ boxShadow: CARD_SHADOW }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-gray-200" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-gray-200 rounded w-1/2" />
                      <div className="h-3 bg-gray-100 rounded w-1/3" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 bg-gray-100 rounded" />
                    <div className="h-3 bg-gray-100 rounded w-5/6" />
                    <div className="h-3 bg-gray-100 rounded w-4/6" />
                  </div>
                </div>
              ))}
            </div>
          )
          : (
            <div
              className="grid gap-4 sm:gap-5 justify-center"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 360px))",
              }}
            >
              {reviews.slice(0, 6).map((r) => (
                <ReviewCard key={r.id} review={r} />
              ))}
            </div>
          )}
        <p className="text-center text-xs text-gray-400 mt-10">
          See kipclip on{" "}
          <a
            href="https://atstore.fyi/products/kipclip"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-600"
          >
            atstore.fyi
          </a>
        </p>
      </div>
    </section>
  );
}
