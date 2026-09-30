import "@fontsource-variable/geist/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeAppearance } from "./appearance";
import { BridgeProvider } from "./bridge";
import { startNativeControls } from "./native";
import "./styles.css";
import "./herdr-tui.css";

initializeAppearance();
startNativeControls();

const root = document.getElementById("root");

if (!root) {
  throw new Error("missing root element");
}

createRoot(root).render(
  <StrictMode>
    <BridgeProvider>
      <App />
    </BridgeProvider>
  </StrictMode>,
);
