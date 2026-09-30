/// <reference types="vite/client" />
import "@fontsource-variable/geist/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createPreviewStorage, createThemePreviewFixture } from "./themePreviewFixture";
import "./styles.css";
import "./herdr-tui.css";

// Separate Vite entry: the default production build only includes index.html.
if (!import.meta.env.DEV) throw new Error("Theme preview is available only in the development server.");

let persistence: Storage | null = null;
try { persistence = window.sessionStorage; } catch { /* Use in-memory storage. */ }
const storage = createPreviewStorage(persistence);
Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
// Live tabs' storage events must not change the isolated preview's preferences.
window.addEventListener("storage", (event) => event.stopImmediatePropagation());

const fixture = createThemePreviewFixture(window.location.origin, (message) => {
  const banner = document.getElementById("theme-preview-banner");
  if (banner) {
    banner.textContent = `THEME PREVIEW · sample sessions · no live connection — ${message}`;
    banner.title = message;
  }
});
const localAssetFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  // Ghostty embeds its WASM in a data URL; reading it performs no network I/O.
  if (url.startsWith("data:application/wasm;base64,") && (!init?.method || init.method === "GET")) {
    return localAssetFetch(input, init);
  }
  return fixture.fetch(input, init);
};
window.WebSocket = fixture.WebSocket;

// Import only after isolation is installed: appearance and app prefs read storage on load.
const [{ App }, { BridgeProvider }, { initializeAppearance }] = await Promise.all([
  import("./App"), import("./bridge"), import("./appearance"),
]);
initializeAppearance();
const root = document.getElementById("root");
if (!root) throw new Error("Missing theme preview root");
createRoot(root).render(<StrictMode><BridgeProvider><App /></BridgeProvider></StrictMode>);
