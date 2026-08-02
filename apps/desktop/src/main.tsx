import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/app.css";

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
