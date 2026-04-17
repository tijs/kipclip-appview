import { PageShell } from "./PageShell.tsx";
import {
  SupporterHowItWorks,
  SupportOnAtprotofansButton,
} from "./SupporterHowItWorks.tsx";

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

      <SupporterHowItWorks />
    </PageShell>
  );
}
