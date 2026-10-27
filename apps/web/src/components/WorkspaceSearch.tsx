import { lazy, Suspense, useEffect, useState } from "react";
import { useLocale } from "../lib/session";
import { t } from "../i18n";
import "./workspace-search.css";

export function SearchIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </svg>
  );
}

export function WorkspaceSearchTrigger({
  compact,
  onClick,
}: {
  compact?: boolean;
  onClick: () => void;
}) {
  const locale = useLocale();
  return (
    <button
      type="button"
      className={`search-launcher${compact ? " search-launcher-mobile" : ""}`}
      onClick={onClick}
      aria-label={t(locale, "search.label")}
      aria-haspopup="dialog"
    >
      <SearchIcon />
      {!compact && (
        <>
          <span>{t(locale, "search.placeholder")}</span>
          <kbd>⌘ / Ctrl K</kbd>
        </>
      )}
    </button>
  );
}


const SearchContent = lazy(() => import("./WorkspaceSearchContent"));

// Keyboard access stays available before the search window has been downloaded.
export function WorkspaceSearchDialog({ open, onClose, onOpen }: {
  open: boolean; onClose: () => void; onOpen: () => void;
}) {
  const locale = useLocale();
  const [loaded, setLoaded] = useState(open);
  useEffect(() => { if (open) setLoaded(true); }, [open]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
        document.getElementById("workspace-search-input")?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
  return loaded || open ? <Suspense fallback={open ? <div role="status">{t(locale, "common.loading")}</div> : null}>
    <SearchContent open={open} onClose={onClose} />
  </Suspense> : null;
}
