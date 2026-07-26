import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import { bridge } from "./bridge.ts";
import "./styles.css";

if (bridge()) {
  document.documentElement.dataset.shell = "electron";
}

const container = document.getElementById("root");

if (!container) {
  throw new Error("The Novus renderer could not find its root element.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
