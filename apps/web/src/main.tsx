import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { HoverHints } from "./components/HoverHints";
import { SaveNotice } from "./components/SaveNotice";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { App } from "./App";
import "./styles.css";
import "./workspace.css";
import "./components/control-notifications.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <PageErrorBoundary>
      <App />
      <HoverHints />
      <SaveNotice />
      </PageErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
