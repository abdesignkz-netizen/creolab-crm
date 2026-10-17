import { InlineFeedback } from "../../components/InlineFeedback";
import { uiMessage, uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { statusBadgeClass } from "../../lib/statusBadge";

const WHATSAPP_LABEL: Record<string, string> = {
  connected: "Подключён",
  active: "Подключён",
  not_connected: "Канал не подключён",
};

export function PlatformAiManagersPage() {
  const { pathname } = useLocation();
  const tenantId = pathname.match(/^\/admin\/ai-managers\/([^/]+)$/)?.[1] || "";
  if (tenantId) return <Navigate replace to={`/admin/companies/${encodeURIComponent(tenantId)}?tab=ai-manager`} />;
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
            {uiText("Здесь видно, готовы ли инструкции и база знаний к ответам в подключённых каналах компании.")}</p>
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
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {!data ? (
        <div className="state">{uiText("Загрузка…")}</div>
      ) : !(data.items || []).length ? (
        <p className="muted">{uiText("Компаний пока нет. Добавьте компанию — здесь появятся настройки её ИИ.")}</p>
      ) : (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>{uiText("Компания")}</th>
                <th>{uiText("Канал связи")}</th>
                <th>{uiText("Промт")}</th>
                <th>{uiText("База знаний")}</th>
                <th>{uiText("Обновлено")}</th>
              </tr>
            </thead>
            <tbody>
              {(data.items || []).map((item: any) => (
                <tr key={item.tenantId}>
                  <td>
                    <Link to={`/admin/companies/${item.tenantId}?tab=ai-manager`}>{item.name}</Link>
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
