import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { SaveNotice } from "./components/SaveNotice";
import { PageErrorBoundary } from "./components/PageErrorBoundary";
import { App } from "./App";
import "./styles.css";
import "./workspace.css";
import "./components/control-notifications.css";

const HoverHints = lazy(() => import("./components/HoverHints").then(module => ({ default: module.HoverHints })));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <PageErrorBoundary>
      <App />
      <Suspense fallback={null}><HoverHints /></Suspense>
      <SaveNotice />
      </PageErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
