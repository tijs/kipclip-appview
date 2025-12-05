/** @jsxImportSource https://esm.sh/react@19 */
import { createRoot } from "https://esm.sh/react-dom@19/client";
import { App } from "./components/App.tsx";
import { AppProvider } from "./context/AppContext.tsx";

// Only run in browser environment
if (typeof document !== "undefined") {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <AppProvider>
      <App />
    </AppProvider>,
  );
}
