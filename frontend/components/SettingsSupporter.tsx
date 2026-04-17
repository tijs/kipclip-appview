/**
 * Settings > Supporter tab.
 * Shows current supporter status, a refresh button, the shared "how it
 * works" explanation, and a CTA (or manage link, for existing supporters).
 */

import { useState } from "react";
import { toast } from "sonner";
import { useApp } from "../context/AppContext.tsx";
import {
  SupporterBadge,
  SupporterCelebrationBadge,
} from "./SupporterBadge.tsx";
import { Button } from "./Button.tsx";
import {
  SupporterHowItWorks,
  SupportOnAtprotofansButton,
} from "./SupporterHowItWorks.tsx";

export function SettingsSupporter() {
  const { isSupporter, refreshSupporterStatus } = useApp();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    const toastId = toast.loading("Checking supporter status...");
    try {
      const result = await refreshSupporterStatus();
      toast.success(
        result
          ? "You're a kipclip supporter — thank you!"
          : "Not a supporter yet",
        { id: toastId },
      );
    } catch (err: any) {
      toast.error(err.message || "Failed to refresh supporter status", {
        id: toastId,
      });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-3xl font-bold text-gray-800 mb-3">
          Supporter
        </h2>
        <p className="text-gray-700 text-lg">
          Your supporter status helps fund kipclip and unlocks premium features
          like import.
        </p>
      </section>

      <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
        {isSupporter && (
          <div className="flex justify-center pt-2">
            <SupporterCelebrationBadge />
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-xl font-bold text-gray-800">Your status</h3>
            {isSupporter && <SupporterBadge />}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            loading={refreshing}
          >
            {refreshing ? "Checking..." : "Refresh status"}
          </Button>
        </div>
        <p className="text-gray-600 text-sm">
          {isSupporter
            ? "You're a kipclip supporter. Import and future supporter features are unlocked. Thank you!"
            : "You're not a kipclip supporter yet. Support to unlock import and help fund development."}
        </p>
        {isSupporter
          ? (
            <a
              href="https://atprotofans.com/support/did:plc:3zzkrrjtsmo7nnwnvhex3auj"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm underline hover:opacity-80"
              style={{ color: "var(--coral-700)" }}
            >
              Manage on atprotofans
            </a>
          )
          : <SupportOnAtprotofansButton />}
      </section>

      <SupporterHowItWorks />
    </div>
  );
}
