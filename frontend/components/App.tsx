/** @jsxImportSource https://esm.sh/react */
import { useEffect, useState } from "https://esm.sh/react";
import { Login } from "./Login.tsx";
import { BookmarkList } from "./BookmarkList.tsx";
import { UserMenu } from "./UserMenu.tsx";
import { TagSidebar } from "./TagSidebar.tsx";
import type { SessionInfo } from "../../shared/types.ts";

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkSession();
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
    <div className="min-h-screen flex flex-col">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1
            className="text-2xl font-bold"
            style={{ color: "var(--coral)" }}
          >
            kipclip
          </h1>
          <UserMenu handle={session.handle} onLogout={handleLogout} />
        </div>
      </header>

      <div className="flex flex-1">
        <TagSidebar />
        <main className="flex-1 px-4 py-8 max-w-7xl mx-auto w-full">
          <BookmarkList />
        </main>
      </div>
    </div>
  );
}
