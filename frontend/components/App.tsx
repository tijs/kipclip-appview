import { useEffect, useState } from "react";
import { Home } from "./Home.tsx";
import { Login } from "./Login.tsx";
import { BookmarkList } from "./BookmarkList.tsx";
import { UserMenu } from "./UserMenu.tsx";
import { TagSidebar } from "./TagSidebar.tsx";
import { Tools } from "./Tools.tsx";
import { About } from "./About.tsx";
import { Save } from "./Save.tsx";
import { FAQ } from "./FAQ.tsx";
import { CreateAccount } from "./CreateAccount.tsx";
import { SharedBookmarks } from "./SharedBookmarks.tsx";
import { Settings } from "./Settings.tsx";
import { ReadingList } from "./ReadingList.tsx";
import { Support } from "./Support.tsx";
import { SupportBanner } from "./SupportBanner.tsx";
import { Press } from "./Press.tsx";
import { PrivacyPolicy } from "./PrivacyPolicy.tsx";
import { TermsOfUse } from "./TermsOfUse.tsx";
import { useApp } from "../context/AppContext.tsx";
import { apiPost } from "../utils/api.ts";
import { saveIdentity } from "../utils/saved-identities.ts";

type ViewType = "bookmarks" | "reading-list";

export function App() {
  const {
    session,
    setSession,
    loadInitialData,
    isSupporter,
    mirrorSyncing,
    firstPageReady,
  } = useApp();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // True while initial /api/initial-data is in-flight (kept alongside
  // firstPageReady so retries can re-spin the loader between an error and
  // the first page of the next attempt).
  const [initialLoadInFlight, setInitialLoadInFlight] = useState(false);
  const [currentPath, setCurrentPath] = useState(globalThis.location.pathname);
  const [currentView, setCurrentView] = useState<ViewType>("bookmarks");

  useEffect(() => {
    checkSession();

    // Check for share target data in URL params and redirect to Save page
    const params = new URLSearchParams(globalThis.location.search);
    if (params.get("action") === "share") {
      const sharedUrl = params.get("url");
      if (sharedUrl) {
        // Redirect to Save page with the shared URL
        globalThis.location.href = `/save?url=${encodeURIComponent(sharedUrl)}`;
        return;
      }
    }

    // Listen for popstate events to update route
    const handlePopState = () => {
      setCurrentPath(globalThis.location.pathname);
    };
    globalThis.addEventListener("popstate", handlePopState);
    return () => globalThis.removeEventListener("popstate", handlePopState);
  }, []);

  function runInitialLoad() {
    setLoadError(null);
    setInitialLoadInFlight(true);
    loadInitialData()
      .catch((error) => {
        console.error("Failed to load initial data:", error);
        setLoadError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        setInitialLoadInFlight(false);
      });
  }

  // Load initial data after session is confirmed
  useEffect(() => {
    if (session && !initialLoadInFlight && !firstPageReady) {
      runInitialLoad();
    }
  }, [session]);

  async function checkSession() {
    try {
      const response = await fetch("/api/auth/session");
      if (response.ok) {
        const data = await response.json();
        setSession({
          did: data.did,
          handle: data.handle,
        });
        saveIdentity(data.handle, data.did);
      }
    } catch (error) {
      console.error("Failed to check session:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await apiPost("/api/auth/logout");
      setSession(null);
    } catch (error) {
      console.error("Failed to logout:", error);
    }
  }

  // Handle special routes that don't require session check
  if (currentPath === "/tools") {
    return <Tools />;
  }

  if (currentPath === "/about") {
    return <About />;
  }

  if (currentPath === "/faq") {
    return <FAQ />;
  }

  if (currentPath === "/support") {
    return <Support />;
  }

  if (currentPath === "/press") {
    return <Press />;
  }

  if (currentPath === "/privacy") {
    return <PrivacyPolicy />;
  }

  if (currentPath === "/terms") {
    return <TermsOfUse />;
  }

  if (currentPath === "/create-account") {
    return <CreateAccount />;
  }

  if (currentPath === "/register") {
    globalThis.location.href = "/create-account";
    return null;
  }

  if (currentPath === "/signin") {
    return <Login />;
  }

  if (currentPath === "/save") {
    return <Save />;
  }

  // Handle shared bookmarks route: /share/:did/:encodedTags
  if (currentPath.startsWith("/share/")) {
    const pathParts = currentPath.split("/");
    if (pathParts.length === 4) {
      const did = pathParts[2];
      const encodedTags = pathParts[3];
      return <SharedBookmarks did={did} encodedTags={encodedTags} />;
    }
  }

  // Show spinner while session probe runs, or while the very first page of
  // /api/initial-data is in flight (no bookmarks visible yet). Once the
  // first page lands (firstPageReady), drop the spinner — background
  // pagination keeps streaming pages in via the streamRemainingPages loop.
  if (
    loading ||
    (session && !firstPageReady && initialLoadInFlight && !loadError)
  ) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!session) {
    if (currentPath === "/") {
      return <Home />;
    }
    return <Login />;
  }

  // AppView fetch failed (post phase 4 there is no client-side fallback
  // store). Surface a hard error with retry rather than rendering an
  // empty bookmark list, which would silently look like a logged-out
  // user with zero bookmarks.
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-4 text-center">
        <p className="text-red-600 mb-2">
          Couldn't load your bookmarks.
        </p>
        <p className="text-gray-500 text-sm mb-6">{loadError}</p>
        <button
          type="button"
          onClick={runInitialLoad}
          className="px-4 py-2 rounded-lg bg-coral text-white"
          style={{ backgroundColor: "var(--coral)" }}
        >
          Try Again
        </button>
      </div>
    );
  }

  // Settings page - requires session and loaded data
  if (currentPath === "/settings") {
    return <Settings />;
  }

  return (
    <div className="min-h-screen md:h-screen flex flex-col">
      <header className="bg-white shadow-sm flex-shrink-0">
        <div className="px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src="https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png"
              alt="Kip logo"
              className="w-8 h-8"
            />
            <h1
              className="hidden md:block text-2xl font-bold"
              style={{ color: "var(--coral)" }}
            >
              kipclip
            </h1>
            <nav className="flex items-center gap-1 ml-2 md:ml-6">
              <button
                type="button"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  currentView === "bookmarks"
                    ? "text-coral"
                    : "text-gray-500 hover:bg-gray-100"
                }`}
                style={currentView === "bookmarks"
                  ? { backgroundColor: "rgba(230, 100, 86, 0.1)" }
                  : {}}
                onClick={() => setCurrentView("bookmarks")}
              >
                Bookmarks
              </button>
              <button
                type="button"
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  currentView === "reading-list"
                    ? "text-coral"
                    : "text-gray-500 hover:bg-gray-100"
                }`}
                style={currentView === "reading-list"
                  ? { backgroundColor: "rgba(230, 100, 86, 0.1)" }
                  : {}}
                onClick={() => setCurrentView("reading-list")}
              >
                Reading List
              </button>
            </nav>
            {mirrorSyncing && (
              <span
                className="hidden sm:inline-flex items-center gap-1.5 ml-2 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{
                  backgroundColor: "rgba(91, 138, 143, 0.12)",
                  color: "var(--teal)",
                }}
                title="Your bookmarks are still syncing from your PDS. New items will appear automatically."
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: "var(--teal)" }}
                />
                Syncing your data
              </span>
            )}
          </div>
          <UserMenu handle={session.handle} onLogout={handleLogout} />
        </div>
      </header>

      {currentView === "bookmarks"
        ? (
          <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">
            <TagSidebar />
            <main className="flex-1 px-4 py-8 max-w-7xl mx-auto w-full md:overflow-y-auto">
              {!isSupporter && <SupportBanner />}
              <BookmarkList />
            </main>
          </div>
        )
        : <ReadingList />}
    </div>
  );
}
