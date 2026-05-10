import type { ReactNode } from "react";
import { Footer } from "./Footer.tsx";
import { useApp } from "../context/AppContext.tsx";

interface PageShellProps {
  children: ReactNode;
  /** Override the back-link label. When omitted, the label adapts to
   *  session state ("Back to Bookmarks" if logged in, "Back to Home"
   *  otherwise) so logged-out visitors don't see a misleading link to
   *  a bookmark list they can't reach. */
  backLabel?: string;
  backHref?: string;
}

export function PageShell({
  children,
  backLabel,
  backHref = "/",
}: PageShellProps) {
  const { session } = useApp();
  const label = backLabel ??
    (session ? "Back to Bookmarks" : "Back to Home");
  return (
    <div
      className="min-h-screen"
      style={{
        background: "linear-gradient(135deg, var(--cream) 0%, #e8f4f5 100%)",
      }}
    >
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <img
              src="https://cdn.kipclip.com/images/kip-vignette.png"
              alt="Kip logo"
              className="w-8 h-8"
            />
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--coral)" }}
            >
              kipclip
            </h1>
          </a>
          <a
            href={backHref}
            className="text-gray-600 hover:text-gray-800 text-sm font-medium"
          >
            {label}
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12 space-y-8">
        {children}
      </main>

      <Footer />
    </div>
  );
}
