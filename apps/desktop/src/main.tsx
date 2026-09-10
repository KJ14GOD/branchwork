import { createRoot } from "react-dom/client";
import { App } from "./app";
import { initTheme } from "./theme";
import { initLayout } from "./layout";
import "./styles/tokens.css";
import "./styles/app.css";

initTheme();
initLayout();
const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
