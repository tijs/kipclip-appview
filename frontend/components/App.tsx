/** @jsxImportSource https://esm.sh/react */
import { useEffect, useState } from "https://esm.sh/react";
import { Login } from "./Login.tsx";
import { BookmarkList } from "./BookmarkList.tsx";
import { UserMenu } from "./UserMenu.tsx";
import { TagSidebar } from "./TagSidebar.tsx";
import { Tools } from "./Tools.tsx";
import { About } from "./About.tsx";
import { Save } from "./Save.tsx";
import { FAQ } from "./FAQ.tsx";
import { SharedBookmarks } from "./SharedBookmarks.tsx";
import { useApp } from "../context/AppContext.tsx";

export function App() {
  const { session, setSession } = useApp();
  const [loading, setLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState(globalThis.location.pathname);

  useEffect(() => {
    checkSession();

    // Listen for popstate events to update route
    const handlePopState = () => {
      setCurrentPath(globalThis.location.pathname);
    };
    globalThis.addEventListener("popstate", handlePopState);
    return () => globalThis.removeEventListener("popstate", handlePopState);
  }, []);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!session) {
    return <Login />;
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
              className="text-2xl font-bold"
              style={{ color: "var(--coral)" }}
            >
              kipclip
            </h1>
          </div>
          <UserMenu handle={session.handle} onLogout={handleLogout} />
        </div>
      </header>

      <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">
        <TagSidebar />
        <main className="flex-1 px-4 py-8 max-w-7xl mx-auto w-full md:overflow-y-auto">
          <BookmarkList />
        </main>
      </div>
    </div>
  );
}
