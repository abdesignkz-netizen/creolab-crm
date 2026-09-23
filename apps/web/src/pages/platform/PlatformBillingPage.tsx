import { FEATURE_LIST, FEATURE_LABEL, LIMIT_LIST, LIMIT_LABEL } from "@creolab/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";

type BillingRequest = {
  id: string;
  company: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerPhone?: string | null;
  planName?: string | null;
  planCode?: string | null;
  addOns?: Array<{ code: string; qty: number }>;
  billingPeriod: string;
  finalAmountMinor: number;
  status: string;
  statusLabel: string;
  createdAt: string;
  requestType: string;
};

function formatKzt(value: number) {
  return `${Number(value).toLocaleString("ru-RU")} ₸`;
}

export function PlatformBillingPage() {
  const [freeStats, setFreeStats] = useState<any>(null);
  const [freeCap, setFreeCap] = useState(0);
  async function loadFree() { const result: any = await api.adminFreeMetrics(); setFreeStats(result); setFreeCap(result.maxActiveFreeTenants); }
  useEffect(() => { void loadFree().catch(err => setError(err.message)); }, []);
  async function saveFreePolicy() {
    setBusy(true); setError("");
    try { await api.adminUpdateFreePolicy({ maxActiveFreeTenants: freeCap }); await loadFree(); notifySaved("Лимит Free сохранён"); }
    catch (err) { setError(err instanceof Error ? err.message : "Ошибка сохранения"); }
    finally { setBusy(false); }
  }
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{ items?: BillingRequest[]; pendingCount?: number } | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setData((await api.adminBillingRequests(status ? { status } : {})) as { items?: BillingRequest[]; pendingCount?: number });
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, [status]);

  async function openRequest(id: string) {
    setError("");
    setSelected(await api.adminBillingRequest(id));
  }

  async function confirm() {
    if (!selected?.request?.id) return;
    setBusy(true);
    try {
      const form = document.getElementById("billing-confirm-form") as HTMLFormElement | null;
      const startDate = form ? String(new FormData(form).get("startDate") || "") : "";
      const endDate = form ? String(new FormData(form).get("endDate") || "") : "";
      const values = form ? new FormData(form) : null;
      const enterpriseTerms = selected.request.planCode === "CRM_ENTERPRISE" && values ? {
        customPriceMinor: Number(values.get("customPriceMinor")),
        sla: String(values.get("sla") || ""), integrations: String(values.get("integrations") || ""),
        limits: Object.fromEntries(LIMIT_LIST.filter(key => key !== "STORAGE_GB").map(key => [key, Number(values.get(`limit:${key}`))])),
        features: Object.fromEntries(FEATURE_LIST.map(key => [key, values.get(`feature:${key}`) === "on"])),
      } : undefined;
      await api.adminConfirmBillingRequest(selected.request.id, { startDate, endDate, ...(enterpriseTerms ? { enterpriseTerms } : {}) });
      notifySaved("Оплата подтверждена, тариф активирован");
      setConfirmOpen(false);
      setSelected(null);
      await load();
      await loadFree();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось активировать");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!selected?.request?.id) return;
    const reason = window.prompt("Причина отклонения") || "";
    setBusy(true);
    try {
      await api.adminRejectBillingRequest(selected.request.id, { reason });
      notifySaved("Запрос отклонён");
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отклонить");
    } finally {
      setBusy(false);
    }
  }

  const items = data?.items || [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Запросы на подключение</h2>
          <p className="muted">Клиент оплачивает вне системы. После проверки нажмите «Подтвердить оплату и активировать».</p>
        </div>
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Все статусы</option>
          <option value="AWAITING_PAYMENT">Ожидает оплаты</option>
          <option value="PAYMENT_REVIEW">На проверке</option>
          <option value="ACTIVATED">Активированы</option>
          <option value="REJECTED">Отклонены</option>
          <option value="CANCELLED">Отменены</option>
        </select>
      </div>
      {freeStats ? <section className="panel stack"><h3>BasQar Free</h3><div className="billing-usage-grid">
        {[["Всего Free", freeStats.total], ["Активные за 30 дней", freeStats.active], ["Неактивные", freeStats.inactive], ["Новые за месяц", freeStats.newThisMonth], ["Перешли на платный", freeStats.converted], ["Free → Start", freeStats.freeToStart], ["Free → CRM + AI", freeStats.freeToCrmAi]].map(([label,value]) => <div key={label}><span>{label}</span><p><b>{value}</b></p></div>)}
      </div><form className="actions" onSubmit={event => { event.preventDefault(); void saveFreePolicy(); }}><label>Максимум активных Free<input type="number" min="0" step="1" value={freeCap} onChange={event => setFreeCap(Number(event.target.value))} /></label><button className="btn secondary" disabled={busy}>Сохранить лимит</button></form><p className="muted">Активность — изменение рабочих данных за последние 30 дней. Изменение лимита не отключает существующие компании.</p></section> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="panel">
        {items.length === 0 ? (
          <p className="muted">Пока нет запросов на тариф.</p>
        ) : (
          <div className="signup-request-list">
            {items.map((item) => (
              <button key={item.id} type="button" className="signup-request-row" onClick={() => void openRequest(item.id)}>
                <div>
                  <b>{item.company}</b>
                  <div className="muted">{item.ownerName || "—"} · {item.ownerEmail || "—"}</div>
                  <div className="muted">
                    {item.planName || item.planCode} · {item.planCode === "CRM_ENTERPRISE" && !item.finalAmountMinor ? "Индивидуально" : formatKzt(item.finalAmountMinor)} · {item.statusLabel} · {formatDateTime(item.createdAt)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <div className="panel stack">
          <h3>{selected.company?.name}</h3>
          <p>Владелец: {selected.owner?.name || "—"} · {selected.owner?.email || "—"} · {selected.owner?.phone || "—"}</p>
          <p>Текущий тариф: {selected.billing?.planName || "Нет"}</p>
          <p>Запрошено: {selected.request?.planName || selected.request?.planCode}</p>
          <p>
            Дополнения:{" "}
            {(selected.request?.addOns || []).length
              ? selected.request.addOns.map((row: { code: string; qty: number }) => `${row.code} × ${row.qty}`).join(", ")
              : "нет"}
          </p>
          <p>Период: {selected.request?.billingPeriod === "YEARLY" ? "1 год" : "1 месяц"}</p>
          <p>Базовая цена: {formatKzt(selected.request?.baseAmountMinor || 0)}</p>
          <dl>{(selected.request?.snapshot?.lines || []).filter((row: any) => row.kind === "addon").map((row: any) => <div key={row.code}>{row.name} × {row.qty}: {formatKzt(row.amountMinor)}{row.chargeType === "ONE_TIME" ? " · разово" : ""}</div>)}</dl>
          <p>Итого: {formatKzt(selected.request?.finalAmountMinor || 0)}</p>
          <p>Статус: {selected.request?.statusLabel}</p>
          <p className="muted"><Link to={`/admin/companies/${selected.company?.id}`}>Открыть компанию</Link></p>
          <div className="actions">
            {["PENDING", "AWAITING_PAYMENT", "PAYMENT_REVIEW", "APPROVED"].includes(selected.request?.status) ? (
              <>
                <button className="btn" type="button" onClick={() => setConfirmOpen(true)}>Подтвердить оплату и активировать</button>
                <button className="btn secondary" type="button" disabled={busy} onClick={() => void reject()}>Отклонить</button>
              </>
            ) : null}
            <button className="btn secondary" type="button" onClick={() => setSelected(null)}>Закрыть</button>
          </div>
        </div>
      ) : null}

      {confirmOpen && selected ? (
        <div className="paywall-backdrop" role="dialog" aria-modal="true">
          <form id="billing-confirm-form" className="panel paywall-card stack" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
            <h2>Подтвердить оплату?</h2>
            <p>Компания: {selected.company?.name}</p>
            <p>Тариф: {selected.request?.planName}</p>
            <p>Сумма: {selected.request?.planCode === "CRM_ENTERPRISE" && !selected.request?.finalAmountMinor ? "Укажите согласованную цену ниже" : formatKzt(selected.request?.finalAmountMinor || 0)}</p>
            <p>Период: {selected.request?.billingPeriod === "YEARLY" ? "1 год" : "1 месяц"}</p>
            {selected.request?.planCode === "CRM_ENTERPRISE" ? <fieldset className="stack"><legend>Индивидуальные условия</legend>
              <label>Согласованная цена за период, ₸<input name="customPriceMinor" type="number" min="1" step="1" required /></label>
              <label>Условия поддержки / SLA<textarea name="sla" maxLength={4000} /></label><label>Согласованные интеграции<textarea name="integrations" maxLength={4000} /></label>
              <p className="muted">Лимиты: −1 означает без квоты. Возможности откроются только после подтверждения оплаты.</p>
              <div className="billing-usage-grid">{LIMIT_LIST.filter(key => key !== "STORAGE_GB").map(key => <label key={key}>{LIMIT_LABEL[key]}<input name={`limit:${key}`} type="number" min="-1" step="1" defaultValue={selected.request?.snapshot?.limits?.[key] ?? 0} required /></label>)}</div>
              <div className="billing-usage-grid">{FEATURE_LIST.map(key => <label key={key}><input name={`feature:${key}`} type="checkbox" defaultChecked={Boolean(selected.request?.snapshot?.features?.[key])} />{FEATURE_LABEL[key]}</label>)}</div>
            </fieldset> : null}
            <label>Начало<input name="startDate" type="date" /></label>
            <label>Окончание<input name="endDate" type="date" /></label>
            <div className="actions">
              <button className="btn secondary" type="button" onClick={() => setConfirmOpen(false)}>Отмена</button>
              <button className="btn" disabled={busy}>Подтвердить и активировать</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
