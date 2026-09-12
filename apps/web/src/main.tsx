import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { HoverHints } from "./components/HoverHints";
import { SaveNotice } from "./components/SaveNotice";
import { App } from "./App";
import "./styles.css";
import "./workspace.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <HoverHints />
      <SaveNotice />
    </BrowserRouter>
  </StrictMode>,
);
