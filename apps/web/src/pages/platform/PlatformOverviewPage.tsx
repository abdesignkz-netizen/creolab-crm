import { InlineFeedback } from "../../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PlatformSignupRequests } from "./PlatformSignupRequests";

export function PlatformOverviewPage() {
  const uiText = useUiText();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminOverview()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
  }, []);

  if (error) return <InlineFeedback kind="error" className="error">{error}</InlineFeedback>;
  if (!data) return <div className="state">{uiText("Загрузка…")}</div>;

  const cards = [
    [uiText("Запросы на подключение"), data.billingPending],
    [uiText("Регистрации"), data.signupPending],
    [uiText("Всего компаний"), data.tenantsTotal],
    [uiText("Активные"), data.tenantsActive],
    [uiText("Приостановленные"), data.tenantsSuspended],
    [uiText("Активные участники"), data.membersActive],
    [uiText("Ожидают приглашения"), data.invitationsPending],
    [uiText("Подключённые интеграции"), data.integrationsConnected],
    [uiText("Ошибки / истекшая авторизация"), data.integrationsUnhealthy],
    [uiText("Требуют назначения"), data.integrationsNeedsAssignment],
  ];

  return (
    <div className="stack">
      <div className="page-head">
        <h2>{uiText("Обзор")}</h2>
        <div className="actions">
        <Link className="btn" to="/admin/companies/new">{uiText("Добавить компанию")}</Link>
        <Link className="btn secondary" to="/admin/billing">{uiText("Запросы на тариф")}</Link>
        <Link className="btn secondary" to="/admin/members">{uiText("Пригласить участника")}</Link>
        <Link className="btn secondary" to="/admin/ai-managers">{uiText("Промт и база знаний")}</Link>
        <Link className="btn secondary" to="/admin/integrations?type=whatsapp_seller">{uiText("Подключить интеграцию")}</Link>
        </div>
      </div>
      <PlatformSignupRequests />
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
