/**
 * Shared "How supporter status works" explanation.
 * Used on the /support page and the Settings > Supporter tab so the two
 * surfaces can't drift.
 */

import { ATPROTOFANS_SUPPORT_URL } from "../../lib/atprotofans.ts";
import { Button } from "./Button.tsx";
import { HeartIcon } from "./HeartIcon.tsx";

function Step(
  { n, title, children }: {
    n: number;
    title: string;
    children: React.ReactNode;
  },
) {
  return (
    <div className="flex gap-4">
      <div
        className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold"
        style={{ backgroundColor: "var(--coral)" }}
      >
        {n}
      </div>
      <div>
        <p className="font-medium text-gray-800">{title}</p>
        <p className="text-gray-600 text-sm mt-1">{children}</p>
      </div>
    </div>
  );
}

export function SupporterHowItWorks() {
  return (
    <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
      <h3 className="text-xl font-bold text-gray-800">
        How it works
      </h3>
      <div className="space-y-4">
        <Step n={1} title='Click "Support on atprotofans"'>
          You'll be taken to{" "}
          <a
            href={ATPROTOFANS_SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-gray-800"
          >
            atprotofans.com
          </a>, a support service built on AT Protocol. Sign in with your
          Bluesky account and choose an amount.
        </Step>

        <Step n={2} title="A record is saved to your account">
          atprotofans writes a small record to your AT Protocol account — think
          of it like a badge that lives alongside your profile and posts. It's
          your data, stored on your own server.
        </Step>

        <Step n={3} title="kipclip recognizes you as a supporter">
          kipclip reads that record from your account and unlocks supporter
          features automatically. No separate login or subscription needed.
        </Step>
      </div>
      <p className="text-gray-600 text-sm border-t border-gray-100 pt-4 mt-2">
        Because this all happens through AT Protocol, any compatible app can
        check your supporter status — it's not locked to kipclip.
      </p>
    </section>
  );
}

/** The "Support on atprotofans" CTA button, reused across pages. */
export function SupportOnAtprotofansButton() {
  return (
    <Button
      variant="primary"
      href={ATPROTOFANS_SUPPORT_URL}
      target="_blank"
      rel="noopener noreferrer"
      leadingIcon={<HeartIcon />}
    >
      Support on atprotofans
    </Button>
  );
}
