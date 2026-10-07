import { InlineFeedback } from "../../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";
import { AssignIntegrationForm } from "./PlatformAssignIntegration";

export function PlatformCatalogPage() {
  const uiText = useUiText();
  const [params] = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [aiTenantId, setAiTenantId] = useState("");
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
    void load().catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
  }, []);

  useEffect(() => {
    if (!focusType || !items.length) return;
    document.getElementById(`integration-${focusType}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusType, items]);

  return (
    <div className="stack">
      <h2>{uiText("Каталог интеграций")}</h2>
      <p className="muted">
        {uiText("Подключение всегда к выбранной компании. Общий WhatsApp-мост сервера к организации не подставляется.")}</p>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <section className="panel stack">
        <h3>{uiText("ИИ-менеджер для любого подключения WhatsApp")}</h3>
        <p>{uiText("QR-код, Green API и официальный WhatsApp используют промпт и базу знаний выбранной компании. Настройте ИИ отдельно от подключения номера.")}</p>
        <label>{uiText("Компания")}<select value={aiTenantId} onChange={event => setAiTenantId(event.target.value)}>
          <option value="">{uiText("Выберите компанию")}</option>
          {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
        </select></label>
        {aiTenantId && <Link className="btn" to={`/admin/companies/${aiTenantId}?tab=ai-manager`}>{uiText("Настроить ИИ-менеджера")}</Link>}
      </section>
      {items.map((item) => (
        <div className="panel stack" key={item.type} id={`integration-${item.type}`}>
          <div className="page-head">
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.type} · {item.authMethod}</div>
            </div>
            <span className={`badge ${item.connectable ? "" : "warn"}`}>
              {item.connectable ? uiText("Можно подключить к компании") : item.implementationReady ? uiText("Не из этой панели") : uiText("Модуль не готов")}
            </span>
          </div>
          <p>{uiText(item.description)}</p>
          {(item.steps || []).length ? (
            item.type === "form" ? (
              <p className="muted">{(item.steps as string[])[0]}</p>
            ) : (
            <div className={`notify-steps ${focusType === item.type ? "catalog-steps-focus" : ""}`}>
              <b>{uiText("Как подключить")}</b>
              <ol>
                {(item.steps as string[]).map((step: string) => (
                  <li key={step}>{uiText(step)}</li>
                ))}
              </ol>
            </div>
            )
          ) : item.connectHint ? (
            <p className="muted">{item.connectHint}</p>
          ) : null}
          <AssignIntegrationForm item={item} companies={companies} />
          {item.type === "form" ? null : <p className="muted">{uiText("Функции:")}{" "}{(item.functions || []).join(", ") || uiText("нет")}</p>}
          <label>
            {uiText("Описание")}<textarea
              defaultValue={item.description}
              onBlur={async (event) => {
                await api.adminUpdateIntegrationType(item.type, { description: event.target.value });
                notifySaved(uiText("Описание сохранено"));
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              defaultChecked={item.available}
              onChange={async (event) => {
                await api.adminUpdateIntegrationType(item.type, { available: event.target.checked });
                notifySaved(uiText("Доступность обновлена"));
                await load();
              }}
            />
            {uiText("Доступен компаниям (если модуль готов)")}</label>
        </div>
      ))}
    </div>
  );
}
