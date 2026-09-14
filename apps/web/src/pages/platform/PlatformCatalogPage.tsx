import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";

export function PlatformCatalogPage() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const data = (await api.adminIntegrationCatalog()) as any;
    setItems(data.items || []);
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка")); }, []);

  return (
    <div className="stack">
      <p className="muted">Тип интеграции — общий способ подключения. Карточка без программного модуля не показывается как «Можно подключить».</p>
      {error ? <p className="error">{error}</p> : null}
      {items.map((item) => (
        <div className="panel stack" key={item.type}>
          <div className="page-head">
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.type} · {item.authMethod}</div>
            </div>
            <span className={`badge ${item.connectable ? "" : "warn"}`}>
              {item.connectable ? "Можно подключить" : item.implementationReady ? "Недоступно компаниям" : "Модуль не готов"}
            </span>
          </div>
          <p>{item.description}</p>
          <p className="muted">Функции: {(item.functions || []).join(", ") || "нет"}</p>
          {item.connectHint ? <p className="muted">{item.connectHint}</p> : null}
          <label>
            Описание
            <textarea defaultValue={item.description} onBlur={async (event) => {
              await api.adminUpdateIntegrationType(item.type, { description: event.target.value });
              notifySaved("Описание сохранено");
            }} />
          </label>
          <label className="check">
            <input
              type="checkbox"
              defaultChecked={item.available}
              onChange={async (event) => {
                await api.adminUpdateIntegrationType(item.type, { available: event.target.checked });
                notifySaved("Доступность обновлена");
                await load();
              }}
            />
            Доступен компаниям (если модуль готов)
          </label>
        </div>
      ))}
    </div>
  );
}
