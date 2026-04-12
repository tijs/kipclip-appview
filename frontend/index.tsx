import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
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
      <Toaster
        position="bottom-center"
        duration={3500}
        toastOptions={{
          style: {
            background: "#1f2937",
            color: "#fff",
            border: "none",
          },
        }}
      />
    </AppProvider>,
  );
}
