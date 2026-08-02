import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initTheme } from "./theme";
import "./styles/tokens.css";
import "./styles/app.css";

initTheme();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
