import { uiMessage, uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { statusBadgeClass } from "../../lib/statusBadge";
import { PlatformCompanyAiManager } from "./PlatformCompanyAiManager";

const WHATSAPP_LABEL: Record<string, string> = {
  connected: "Подключён",
  active: "Подключён",
  not_connected: "Нет WhatsApp",
};

export function PlatformAiManagersPage() {
  const { pathname } = useLocation();
  const tenantId = pathname.match(/^\/admin\/ai-managers\/([^/]+)$/)?.[1] || "";
  if (tenantId) return <AiManagerDetail tenantId={tenantId} />;
  return <AiManagerList />;
}

function AiManagerList() {
  const uiText = useUiText();
  const [q, setQ] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load(search = q) {
    setError("");
    try {
      setData(await api.adminAiManagers({ q: search }));
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось загрузить AI-менеджеров"));
    }
  }

  useEffect(() => {
    void load("");
  }, []);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>{uiText("AI-менеджеры")}</h2>
          <p className="muted">
            {uiText("Для каждой компании видно, активны ли промт и база знаний в WhatsApp. Зелёный статус — бот уже отвечает по этим текстам.")}</p>
        </div>
      </div>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          void load(q);
        }}
      >
        <input value={q} onChange={(event) => setQ(event.target.value)} placeholder={uiText("Найти компанию")} />
        <button className="btn secondary" type="submit">
          {uiText("Найти")}</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {!data ? (
        <div className="state">{uiText("Загрузка…")}</div>
      ) : !(data.items || []).length ? (
        <p className="muted">{uiText("Компаний пока нет. Добавьте компанию — здесь появится её WhatsApp AI.")}</p>
      ) : (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>{uiText("Компания")}</th>
                <th>WhatsApp</th>
                <th>{uiText("Промт")}</th>
                <th>{uiText("База знаний")}</th>
                <th>{uiText("Обновлено")}</th>
              </tr>
            </thead>
            <tbody>
              {(data.items || []).map((item: any) => (
                <tr key={item.tenantId}>
                  <td>
                    <Link to={`/admin/ai-managers/${item.tenantId}`}>{item.name}</Link>
                    <div className="muted">{item.slug}</div>
                  </td>
                  <td>
                    <span className={statusBadgeClass(WHATSAPP_LABEL[item.whatsapp] || item.whatsapp)}>
                      {localizeUiOptions(WHATSAPP_LABEL, uiText)[item.whatsapp] || item.whatsapp}
                    </span>
                  </td>
                  <td>
                    <div className="ai-live-cell">
                      <span className={statusBadgeClass(item.promptActivation?.label || (item.promptReady ? "задан" : "Не задан"))}>
                        {uiMessage(item.promptActivation?.label) || (item.promptReady ? uiText("задан") : uiText("Не задан"))}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="ai-live-cell">
                      <span
                        className={statusBadgeClass(
                          item.knowledgeActivation?.label || (item.knowledgeCount ? "задана" : "Не задана"),
                        )}
                      >
                        {uiMessage(item.knowledgeActivation?.label) || (item.knowledgeCount ? uiText("задана") : uiText("Не задана"))}
                      </span>
                      <div className="muted">{item.knowledgeCount || 0}</div>
                    </div>
                  </td>
                  <td>{item.updatedAt ? formatDateTime(item.updatedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AiManagerDetail({ tenantId }: { tenantId: string }) {
  const uiText = useUiText();
  const [name, setName] = useState("");
  useEffect(() => {
    void api
      .adminCompanyAiManager(tenantId)
      .then((row: any) => setName(row.tenant?.name || ""))
      .catch(() => setName(""));
  }, [tenantId]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin/ai-managers">{uiText("AI-менеджеры")}</Link>
            {" · "}
            <Link to={`/admin/companies/${tenantId}`}>{uiText("Карточка компании")}</Link>
          </p>
          <h3>{name || "WhatsApp AI"}</h3>
        </div>
      </div>
      <PlatformCompanyAiManager tenantId={tenantId} />
    </div>
  );
}
