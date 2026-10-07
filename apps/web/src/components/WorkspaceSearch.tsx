import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useUiText } from "../lib/uiText";
import { useLocale } from "../lib/session";
import { t } from "../i18n";
import "./workspace-search.css";

function SearchIcon() {
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

type SearchItem = {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
};

export function WorkspaceSearchDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
}) {
  const locale = useLocale();
  const uiText = useUiText();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchItem[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [active, setActive] = useState(-1);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      input.current?.focus();
    } else {
      dialog.current?.close();
      setQuery("");
      setItems([]);
      setActive(-1);
    }
  }, [open]);

  useEffect(() => {
    const value = query.trim();
    let cancelled = false;
    setItems([]);
    setActive(-1);
    if (!open || value.length < 2) {
      setStatus("idle");
      return;
    }
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void api
        .searchWorkspace(value)
        .then((result: any) => {
          if (cancelled) return;
          setItems(result.items || []);
          setStatus("ready");
        })
        .catch(() => {
          if (!cancelled) setStatus("error");
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, revision, open]);

  useEffect(() => {
    if (active >= 0)
      document
        .getElementById(`workspace-result-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const types: Record<string, string> = {
    contact: t(locale, "search.contact"),
    company: t(locale, "search.company"),
    deal: t(locale, "search.deal"),
    inquiry: t(locale, "search.inquiry"),
    task: t(locale, "search.task"),
    conversation: t(locale, "search.conversation"),
  };
  const choose = (item: SearchItem) => {
    onClose();
    navigate(item.href);
  };

  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-labelledby="workspace-search-title"
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <div className="search-dialog-heading">
        <h2 id="workspace-search-title">{uiText("Поиск по сервису")}</h2>
        <button
          type="button"
          className="search-close"
          onClick={onClose}
          aria-label={t(locale, "common.close")}
        >
          ×
        </button>
      </div>
      <div className="search-dialog-input">
        <SearchIcon />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(locale, "search.placeholder")}
          aria-label={t(locale, "search.label")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={items.length > 0}
          aria-controls="workspace-search-results"
          aria-activedescendant={
            active >= 0 ? `workspace-result-${active}` : undefined
          }
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (items.length)
                setActive((value) =>
                  e.key === "ArrowDown"
                    ? (value + 1) % items.length
                    : value <= 0
                      ? items.length - 1
                      : value - 1,
                );
            }
            if (e.key === "Enter" && active >= 0 && items[active]) {
              e.preventDefault();
              choose(items[active]);
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="search-close"
            aria-label={uiText("Очистить поиск")}
            onClick={() => {
              setQuery("");
              input.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>
      <div className="search-dialog-content">
        <div role="status" className="search-status">
          {status === "idle" && (
            <>
              <b>{uiText("Найдите нужное без перехода по разделам")}</b>
              <p>
                {uiText(
                  "Введите минимум 2 символа: имя, телефон, компанию или название задачи.",
                )}
              </p>
            </>
          )}
          {status === "loading" && t(locale, "common.loading")}
          {status === "ready" && !items.length && (
            <>
              <b>{t(locale, "search.empty")}</b>
              <p>
                {uiText(
                  "Попробуйте другое имя, номер или более короткий запрос.",
                )}
              </p>
            </>
          )}
          {status === "error" && (
            <>
              <b>{uiText("Не удалось выполнить поиск")}</b>
              <p>{uiText("Проверьте соединение и попробуйте ещё раз.")}</p>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setRevision((value) => value + 1)}
              >
                {t(locale, "common.retry")}
              </button>
            </>
          )}
        </div>
        <div
          id="workspace-search-results"
          role="listbox"
          aria-label={uiText("Результаты поиска")}
        >
          {items.map((item, index) => (
            <button
              key={`${item.type}:${item.id}`}
              id={`workspace-result-${index}`}
              type="button"
              role="option"
              aria-selected={active === index}
              className="search-result"
              onClick={() => choose(item)}
            >
              <span className="search-result-avatar" aria-hidden="true">
                {item.title.slice(0, 1).toUpperCase()}
              </span>
              <span className="search-result-copy">
                <strong>{item.title}</strong>
                <span>
                  {[types[item.type] || item.type, item.subtitle]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </div>
      <div className="search-dialog-footer">
        {uiText("↑ ↓ выбрать · Enter открыть · Esc закрыть")}
      </div>
    </dialog>
  );
}
