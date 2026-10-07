import { InlineFeedback } from "../../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";

export function PlatformAuditPage() {
  const uiText = useUiText();
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load() {
    setData(await api.adminAudit({ q, limit: 50 }));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
  }, []);

  return (
    <div className="stack">
      <h2>{uiText("Журнал действий")}</h2>
      <form className="filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={uiText("Фильтр по действию")} />
        <button className="btn secondary">{uiText("Найти")}</button>
      </form>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {!data ? <div className="state">{uiText("Загрузка…")}</div> : (data.items || []).map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.action}</b>
            <div className="muted">
              {formatDateTime(item.createdAt)} · {item.actor?.email || uiText("система")} · {item.tenantName || uiText("сервис")} · {item.entityType}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
