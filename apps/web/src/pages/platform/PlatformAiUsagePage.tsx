import { InlineFeedback } from "../../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";

function money(value: number) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function tokens(value: number) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function PlatformAiUsagePage({ lockedTenantId }: { lockedTenantId?: string }) {
  const uiText = useUiText();
  const [period, setPeriod] = useState("last_7");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load(nextPeriod = period) {
    setError("");
    try {
      const query = { period: nextPeriod, tenantId: lockedTenantId };
      setData(
        lockedTenantId
          ? await api.adminCompanyAiUsage(lockedTenantId, query)
          : await api.adminAiUsage(query),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось загрузить AI Usage"));
    }
  }

  useEffect(() => {
    void load();
  }, [lockedTenantId]);

  if (error) return <InlineFeedback kind="error" className="error">{error}</InlineFeedback>;
  if (!data) return <div className="state">{uiText("Загрузка…")}</div>;
  const totals = data.totals || {};

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>{uiText("Расход AI")}</h2>
          <p className="muted">{uiText("Внутренняя себестоимость. Клиентам не показывается.")}</p>
        </div>
        <div className="actions">
          {[
            ["today", uiText("Сегодня")],
            ["yesterday", uiText("Вчера")],
            ["last_7", uiText("7 дней")],
            ["last_30", uiText("30 дней")],
            ["custom", uiText("Диапазон")],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={period === value ? "btn" : "btn secondary"}
              onClick={() => {
                if (value === "custom") {
                  const from = window.prompt(uiText("С (YYYY-MM-DD)"), "") || "";
                  const to = window.prompt(uiText("По (YYYY-MM-DD)"), "") || "";
                  setPeriod("custom");
                  const query = { period: "custom", from, to, tenantId: lockedTenantId };
                  void (lockedTenantId ? api.adminCompanyAiUsage(lockedTenantId, query) : api.adminAiUsage(query))
                    .then(setData)
                    .catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
                  return;
                }
                setPeriod(value);
                void load(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="integ-grid">
        <div className="panel"><b>Requests</b><p>{totals.requests || 0}</p></div>
        <div className="panel"><b>Input Tokens</b><p>{tokens(totals.inputTokens)}</p></div>
        <div className="panel"><b>Output Tokens</b><p>{tokens(totals.outputTokens)}</p></div>
        <div className="panel"><b>Total Tokens</b><p>{tokens(totals.totalTokens)}</p></div>
        <div className="panel"><b>Estimated AI Cost</b><p>{money(totals.cost)}</p></div>
        {totals.activeTenants != null ? (
          <div className="panel"><b>Active Tenants</b><p>{totals.activeTenants}</p></div>
        ) : null}
        {totals.averageCostPerTenant != null ? (
          <div className="panel"><b>Average Cost / Tenant</b><p>{money(totals.averageCostPerTenant)}</p></div>
        ) : null}
      </div>
      {(data.failedRequests || []).length ? (
        <section className="panel">
          <h3>{uiText("Ошибки запросов ИИ")}</h3>
          <p className="muted">{uiText("Последние 50 ошибок за выбранный период. Код ошибки помогает определить причину сбоя.")}</p>
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr>
                <th>{uiText("Дата")}</th><th>{uiText("Компания")}</th><th>{uiText("Провайдер")}</th>
                <th>{uiText("Модель")}</th><th>{uiText("Операция")}</th><th>{uiText("Код ошибки")}</th>
              </tr></thead>
              <tbody>{data.failedRequests.map((row: any) => <tr key={row.id}>
                <td>{formatDateTime(row.createdAt)}</td><td>{row.companyName || "—"}</td>
                <td>{row.provider}</td><td>{row.model}</td>
                <td>{row.feature === "AI_VOICE_TRANSCRIPTION" ? uiText("Распознавание голосового сообщения") : row.feature}</td>
                <td><code>{row.errorCode}</code></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
      ) : null}
      {(data.anomalies || []).length ? (
        <div className="banner warn">
          ⚠ AI Usage anomaly
          <ul>
            {(data.anomalies || []).map((row: any) => (
              <li key={row.tenantId}>
                {row.name}: {tokens(row.tokens)} {" "}{uiText("при обычных")}{" "}{tokens(row.usual)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.tenants ? (
        <div className="panel">
          <h4>{uiText("По компаниям")}</h4>
          <table className="table">
            <thead>
              <tr>
                <th>{uiText("Компания")}</th>
                <th>Requests</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Avg / request</th>
              </tr>
            </thead>
            <tbody>
              {(data.tenants || []).map((row: any) => (
                <tr key={row.tenantId || "unscoped"}>
                  <td>
                    {row.tenantId ? <Link to={`/admin/companies/${row.tenantId}`}>{row.name}</Link> : row.name}
                  </td>
                  <td>{row.requests}</td>
                  <td>{tokens(row.totalTokens)}</td>
                  <td>{money(row.cost)}</td>
                  <td>{money(row.avgCostPerRequest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data.byFeature ? (
        <div className="panel">
          <h4>{uiText("По функциям")}</h4>
          {(data.byFeature || []).map((row: any) => (
            <p key={row.name}>{row.name} · {tokens(row.totalTokens)} · {money(row.cost)}</p>
          ))}
        </div>
      ) : null}
      {data.byProvider ? (
        <div className="panel">
          <h4>{uiText("По provider")}</h4>
          {(data.byProvider || []).map((row: any) => (
            <p key={row.name}>{row.name} · {tokens(row.totalTokens)} · {money(row.cost)}</p>
          ))}
        </div>
      ) : null}
      {data.byModel ? (
        <div className="panel">
          <h4>{uiText("По моделям")}</h4>
          {(data.byModel || []).map((row: any) => (
            <p key={row.name}>{row.name} · {tokens(row.totalTokens)} · {money(row.cost)}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
