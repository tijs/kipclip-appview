import { useEffect, useState } from "react";
import { Login } from "./Login.tsx";
import { BookmarkList } from "./BookmarkList.tsx";
import { UserMenu } from "./UserMenu.tsx";
import { TagSidebar } from "./TagSidebar.tsx";
import { Tools } from "./Tools.tsx";
import { About } from "./About.tsx";
import { Save } from "./Save.tsx";
import { FAQ } from "./FAQ.tsx";
import { Register } from "./Register.tsx";
import { SharedBookmarks } from "./SharedBookmarks.tsx";
import { Settings } from "./Settings.tsx";
import { ReadingList } from "./ReadingList.tsx";
import { useApp } from "../context/AppContext.tsx";

type ViewType = "bookmarks" | "reading-list";

export function App() {
  const { session, setSession, loadInitialData } = useApp();
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
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

  // Load initial data after session is confirmed
  useEffect(() => {
    if (session && !dataLoading) {
      setDataLoading(true);
      loadInitialData()
        .catch((error) => {
          console.error("Failed to load initial data:", error);
        })
        .finally(() => {
          setDataLoading(false);
        });
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
      }
    } catch (error) {
      console.error("Failed to check session:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
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

  if (currentPath === "/register") {
    return <Register />;
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

  if (loading || dataLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!session) {
    return <Login />;
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
          </div>
          <UserMenu handle={session.handle} onLogout={handleLogout} />
        </div>
      </header>

      {currentView === "bookmarks"
        ? (
          <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">
            <TagSidebar />
            <main className="flex-1 px-4 py-8 max-w-7xl mx-auto w-full md:overflow-y-auto">
              <BookmarkList />
            </main>
          </div>
        )
        : <ReadingList />}
    </div>
  );
}
