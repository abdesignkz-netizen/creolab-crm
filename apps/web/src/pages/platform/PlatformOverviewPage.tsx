import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";

export function PlatformOverviewPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminOverview()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <div className="state">Загрузка…</div>;

  const cards = [
    ["Всего компаний", data.tenantsTotal],
    ["Активные", data.tenantsActive],
    ["Приостановленные", data.tenantsSuspended],
    ["Активные участники", data.membersActive],
    ["Ожидают приглашения", data.invitationsPending],
    ["Подключённые интеграции", data.integrationsConnected],
    ["Ошибки / истекшая авторизация", data.integrationsUnhealthy],
    ["Требуют назначения", data.integrationsNeedsAssignment],
  ];

  return (
    <div className="stack">
      <div className="actions">
        <Link className="btn" to="/admin/companies/new">Добавить компанию</Link>
        <Link className="btn secondary" to="/admin/members">Пригласить участника</Link>
        <Link className="btn secondary" to="/admin/companies">Подключить интеграцию</Link>
      </div>
      <div className="kpi-grid">
        {cards.map(([label, value]) => (
          <div className="panel" key={label}>
            <div className="muted">{label}</div>
            <b className="kpi-value">{value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
