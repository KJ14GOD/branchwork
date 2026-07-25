import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("The Novus renderer could not find its root element.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
