import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { AppProvider } from "./context/AppContext.tsx";

// Only run in browser environment
if (typeof document !== "undefined") {
  // Register service worker for PWA support
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/static/sw.js").then(
      (registration) => {
        console.log("SW registered:", registration.scope);
      },
      (error) => {
        console.error("SW registration failed:", error);
      },
    );
  }

  const root = createRoot(document.getElementById("root")!);
  root.render(
    <AppProvider>
      <App />
    </AppProvider>,
  );
}
