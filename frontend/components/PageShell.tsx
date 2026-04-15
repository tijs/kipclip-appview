import type { ReactNode } from "react";
import { Footer } from "./Footer.tsx";

interface PageShellProps {
  children: ReactNode;
  backLabel?: string;
  backHref?: string;
}

export function PageShell({
  children,
  backLabel = "Back to Bookmarks",
  backHref = "/",
}: PageShellProps) {
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
              src="https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png"
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
            {backLabel}
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
