import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";

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
      setError(err instanceof Error ? err.message : "Не удалось загрузить AI Usage");
    }
  }

  useEffect(() => {
    void load();
  }, [lockedTenantId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <div className="state">Загрузка…</div>;
  const totals = data.totals || {};

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Расход AI</h2>
          <p className="muted">Внутренняя себестоимость. Клиентам не показывается.</p>
        </div>
        <div className="actions">
          {[
            ["today", "Сегодня"],
            ["yesterday", "Вчера"],
            ["last_7", "7 дней"],
            ["last_30", "30 дней"],
            ["custom", "Диапазон"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={period === value ? "btn" : "btn secondary"}
              onClick={() => {
                if (value === "custom") {
                  const from = window.prompt("С (YYYY-MM-DD)", "") || "";
                  const to = window.prompt("По (YYYY-MM-DD)", "") || "";
                  setPeriod("custom");
                  const query = { period: "custom", from, to, tenantId: lockedTenantId };
                  void (lockedTenantId ? api.adminCompanyAiUsage(lockedTenantId, query) : api.adminAiUsage(query))
                    .then(setData)
                    .catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
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
      {(data.anomalies || []).length ? (
        <div className="banner warn">
          ⚠ AI Usage anomaly
          <ul>
            {(data.anomalies || []).map((row: any) => (
              <li key={row.tenantId}>
                {row.name}: {tokens(row.tokens)} при обычных {tokens(row.usual)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.tenants ? (
        <div className="panel">
          <h4>По компаниям</h4>
          <table className="table">
            <thead>
              <tr>
                <th>Компания</th>
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
          <h4>По функциям</h4>
          {(data.byFeature || []).map((row: any) => (
            <p key={row.name}>{row.name} · {tokens(row.totalTokens)} · {money(row.cost)}</p>
          ))}
        </div>
      ) : null}
      {data.byProvider ? (
        <div className="panel">
          <h4>По provider</h4>
          {(data.byProvider || []).map((row: any) => (
            <p key={row.name}>{row.name} · {tokens(row.totalTokens)} · {money(row.cost)}</p>
          ))}
        </div>
      ) : null}
      {data.byModel ? (
        <div className="panel">
          <h4>По моделям</h4>
          {(data.byModel || []).map((row: any) => (
            <p key={row.name}>{row.name} · {tokens(row.totalTokens)} · {money(row.cost)}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
