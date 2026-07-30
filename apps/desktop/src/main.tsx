import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import { bridge } from "./bridge.ts";
import { initialTheme } from "./use-theme.ts";
import "./styles.css";

if (bridge()) {
  document.documentElement.dataset.shell = "electron";
}

// Stamped before the first paint, not in an effect — `useTheme` re-derives
// the same value and keeps this in sync, but waiting for React to mount
// would flash the CSS default (dark) for one frame on every launch where the
// stored preference is light.
document.documentElement.dataset.theme = initialTheme();

const container = document.getElementById("root");

if (!container) {
  throw new Error("The Novus renderer could not find its root element.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
