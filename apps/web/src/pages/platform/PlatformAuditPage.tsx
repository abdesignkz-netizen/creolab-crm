import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";

export function PlatformAuditPage() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load() {
    setData(await api.adminAudit({ q, limit: 50 }));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, []);

  return (
    <div className="stack">
      <h2>Журнал действий</h2>
      <form className="filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Фильтр по действию" />
        <button className="btn secondary">Найти</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {!data ? <div className="state">Загрузка…</div> : (data.items || []).map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.action}</b>
            <div className="muted">
              {formatDateTime(item.createdAt)} · {item.actor?.email || "система"} · {item.tenantName || "сервис"} · {item.entityType}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
