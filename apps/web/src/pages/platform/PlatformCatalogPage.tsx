import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";
import { AssignIntegrationForm } from "./PlatformAssignIntegration";

export function PlatformCatalogPage() {
  const [params] = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [error, setError] = useState("");
  const focusType = params.get("type") || "";

  async function load() {
    const [catalog, tenants] = await Promise.all([
      api.adminIntegrationCatalog() as Promise<any>,
      api.adminTenants({ status: "active", limit: 100 }) as Promise<any>,
    ]);
    setItems(catalog.items || []);
    setCompanies(tenants.items || []);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, []);

  useEffect(() => {
    if (!focusType || !items.length) return;
    document.getElementById(`integration-${focusType}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusType, items]);

  return (
    <div className="stack">
      <p className="muted">
        Подключение всегда к выбранной компании. Общий WhatsApp-мост сервера к организации не подставляется.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {items.map((item) => (
        <div className="panel stack" key={item.type} id={`integration-${item.type}`}>
          <div className="page-head">
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.type} · {item.authMethod}</div>
            </div>
            <span className={`badge ${item.connectable ? "" : "warn"}`}>
              {item.connectable ? "Можно подключить к компании" : item.implementationReady ? "Не из этой панели" : "Модуль не готов"}
            </span>
          </div>
          <p>{item.description}</p>
          {(item.steps || []).length ? (
            item.type === "form" ? (
              <p className="muted">{(item.steps as string[])[0]}</p>
            ) : (
            <div className={`notify-steps ${focusType === item.type ? "catalog-steps-focus" : ""}`}>
              <b>Как подключить</b>
              <ol>
                {(item.steps as string[]).map((step: string) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
            )
          ) : item.connectHint ? (
            <p className="muted">{item.connectHint}</p>
          ) : null}
          <AssignIntegrationForm item={item} companies={companies} />
          {item.type === "form" ? null : <p className="muted">Функции: {(item.functions || []).join(", ") || "нет"}</p>}
          <label>
            Описание
            <textarea
              defaultValue={item.description}
              onBlur={async (event) => {
                await api.adminUpdateIntegrationType(item.type, { description: event.target.value });
                notifySaved("Описание сохранено");
              }}
            />
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
