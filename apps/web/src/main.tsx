import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { HoverHints } from "./components/HoverHints";
import { App } from "./App";
import "./styles.css";
import "./workspace.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <HoverHints />
    </BrowserRouter>
  </StrictMode>,
);
