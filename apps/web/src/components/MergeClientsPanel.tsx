import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useUiText } from "../lib/uiText";
import { InlineFeedback } from "./InlineFeedback";
import { notifySaved } from "./SaveNotice";

type Contact = {
  id: string;
  name: string;
  phone?: string;
  companyName?: string;
};

function ContactChoice({
  label,
  value,
  excludeId,
  disabled,
  onChange,
}: {
  label: string;
  value: Contact | null;
  excludeId?: string;
  disabled: boolean;
  onChange: (contact: Contact | null) => void;
}) {
  const uiText = useUiText();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setHits([]);
    setError("");
    if (value || query.trim().length < 2) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api
        .contacts({
          q: query.trim(),
          filter: "all",
          period: "all",
          offset: "0",
        })
        .then((result: any) => {
          if (active)
            setHits(
              (result.items || [])
                .filter((item: Contact) => item.id !== excludeId)
                .slice(0, 8),
            );
        })
        .catch((err) => {
          if (active)
            setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, value, excludeId]);

  return (
    <div className="merge-client-choice">
      {value ? (
        <div className="panel soft">
          <b>{label}</b>
          <p>
            {value.name} · {value.phone || uiText("Нет телефона")}
          </p>
          {value.companyName ? (
            <p className="muted">{value.companyName}</p>
          ) : null}
          <div className="actions">
            <Link to={`/contacts/${value.id}`} target="_blank" rel="noreferrer">
              {uiText("Открыть карточку")}
            </Link>
            <button
              type="button"
              className="btn secondary"
              disabled={disabled}
              onClick={() => {
                onChange(null);
                setQuery("");
              }}
            >
              {uiText("Изменить")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <label>
            {label}
            <input
              type="search"
              value={query}
              disabled={disabled}
              autoComplete="off"
              placeholder={uiText("Имя или телефон — минимум 2 символа")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div aria-live="polite">
            {loading ? (
              <p className="muted">{uiText("Поиск…")}</p>
            ) : error ? (
              <p className="error">{error}</p>
            ) : query.trim().length >= 2 && !hits.length ? (
              <p className="muted">{uiText("Клиенты не найдены")}</p>
            ) : null}
          </div>
          <div className="picker-list">
            {hits.map((contact) => (
              <button
                type="button"
                className="picker-item"
                key={contact.id}
                disabled={disabled}
                onClick={() => onChange(contact)}
              >
                <b>{contact.name}</b>
                <span className="muted">
                  {[contact.phone, contact.companyName]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function MergeClientsPanel({
  onMerged,
  initialKeepId,
}: {
  onMerged: () => Promise<void>;
  initialKeepId?: string;
}) {
  const uiText = useUiText();
  const [keep, setKeep] = useState<Contact | null>(null);
  const [source, setSource] = useState<Contact | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flight = useRef(false);
  const panelRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!initialKeepId) return;
    let active = true;
    if (panelRef.current) {
      panelRef.current.open = true;
      panelRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    void api
      .contactOverview(initialKeepId)
      .then((result: any) => {
        if (active && result.client) {
          setKeep(result.client);
          setSource(null);
          setConfirmed(false);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [initialKeepId]);
  return (
    <details ref={panelRef} className="workspace-disclosure">
      <summary>{uiText("Объединить дубликаты")}</summary>
      <p className="muted">
        {uiText(
          "Оставляем первого клиента, второго архивируем и переносим заявки, сделки и диалоги.",
        )}
      </p>
      <div className="merge-client-grid">
        <ContactChoice
          label={uiText("Основная карточка — останется")}
          value={keep}
          excludeId={source?.id}
          disabled={busy}
          onChange={(value) => {
            setKeep(value);
            setConfirmed(false);
            setError("");
          }}
        />
        <ContactChoice
          label={uiText("Дубликат — будет объединён")}
          value={source}
          excludeId={keep?.id}
          disabled={busy}
          onChange={(value) => {
            setSource(value);
            setConfirmed(false);
            setError("");
          }}
        />
      </div>
      {keep && source && keep.id !== source.id ? (
        <div className="merge-client-confirm">
          <p>
            <b>{source.name}</b> → <b>{keep.name}</b>
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>{uiText("Проверил карточки: это один и тот же клиент")}</span>
          </label>
          <button
            type="button"
            className="btn"
            disabled={!confirmed || busy}
            onClick={async () => {
              if (flight.current || !confirmed || keep.id === source.id) return;
              flight.current = true;
              setBusy(true);
              setError("");
              try {
                await api.mergeContacts({
                  keepId: keep.id,
                  mergeId: source.id,
                });
                setKeep(null);
                setSource(null);
                setConfirmed(false);
                notifySaved(uiText("Клиенты объединены"));
                await onMerged();
              } catch (err) {
                setError(
                  err instanceof Error
                    ? err.message
                    : uiText("Не удалось объединить"),
                );
              } finally {
                flight.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? uiText("Объединяем…") : uiText("Объединить клиентов")}
          </button>
        </div>
      ) : null}
      {error ? <InlineFeedback kind="error">{error}</InlineFeedback> : null}
    </details>
  );
}
