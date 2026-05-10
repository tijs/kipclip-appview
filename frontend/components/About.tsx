import { PageShell } from "./PageShell.tsx";
import { releaseUrl, useVersion } from "../utils/version.ts";

export function About() {
  const info = useVersion();
  const tagLink = info ? releaseUrl(info.version) : null;
  return (
    <PageShell>
      <section>
        <h2 className="text-3xl font-bold text-gray-800 mb-3">
          About kipclip
        </h2>
        <p className="text-gray-700 text-lg">
          kipclip is a free, open bookmark manager. Save links you care about,
          organize them with tags, and access them from any device.
        </p>
      </section>

      <section
        id="how-it-works"
        className="bg-white rounded-lg shadow-md p-6 space-y-3"
      >
        <h3 className="text-xl font-bold text-gray-800">How it works</h3>
        <ul className="list-disc pl-5 text-gray-700 space-y-2">
          <li>
            Your bookmarks are stored in your own account, not on kipclip's
            servers — you own your data.
          </li>
          <li>
            kipclip is built on{" "}
            <a
              href="/faq#how-the-technology-works"
              className="underline hover:text-gray-800"
            >
              AT Protocol
            </a>
            , an open standard, so other apps can read your bookmarks too.
          </li>
          <li>
            The app is a lightweight web client. Your data lives with you.
          </li>
        </ul>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
        <h3 className="text-xl font-bold text-gray-800">
          Important note on privacy
        </h3>
        <p className="text-gray-700">
          Bookmarks you save are public and can be discovered by others. Don't
          save anything sensitive or private.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
        <h3 className="text-xl font-bold text-gray-800">Have questions?</h3>
        <p className="text-gray-700">
          Check out our{" "}
          <a
            href="/faq"
            className="underline hover:text-gray-800"
          >
            Frequently Asked Questions
          </a>{" "}
          page to learn more about how kipclip works.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-3">
        <h3 className="text-xl font-bold text-gray-800">
          Support kipclip
        </h3>
        <p className="text-gray-700">
          kipclip is a personal project and free to use. If you find it useful,
          consider{" "}
          <a
            href="/support"
            className="underline hover:text-gray-800"
          >
            supporting the project
          </a>{" "}
          — it helps fund development and other AT Protocol apps by the same
          creator.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6">
        <h3 className="text-xl font-bold text-gray-800 mb-4">Links</h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <a
            href="https://tangled.org/tijs.org/kipclip-appview"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-white hover:opacity-95"
            style={{ backgroundColor: "var(--coral)" }}
          >
            <img
              src="https://cdn.kipclip.com/images/tangled.svg"
              alt=""
              width={20}
              height={20}
              style={{ filter: "brightness(0) invert(1)" }}
            />
            Source on Tangled
          </a>
          <a
            href="https://bsky.app/profile/tijs.org"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-white hover:opacity-95"
            style={{ backgroundColor: "#1185FF" }}
          >
            <span aria-hidden className="text-lg">🦋</span>
            made bij tijs.org
          </a>
          <a
            href="/press"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-white hover:opacity-95"
            style={{ backgroundColor: "var(--teal)" }}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
              />
            </svg>
            Press Kit
          </a>
        </div>
        {info && (
          <p className="mt-6 text-sm text-gray-500">
            Running {tagLink
              ? (
                <a
                  href={tagLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-700"
                >
                  {info.version}
                </a>
              )
              : <span className="font-medium">{info.version}</span>}
          </p>
        )}
      </section>
    </PageShell>
  );
}
